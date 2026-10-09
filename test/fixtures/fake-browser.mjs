#!/usr/bin/env node
// Stands in for a Chromium binary in launch tests: speaks NUL-framed CDP on fd 3/4 like
// --remote-debugging-pipe. FAKE_BROWSER_MODE: 'old' (reports Chromium 100) or 'exit' (dies at
// start); FAKE_BROWSER_ARGS: file to record argv in.
import { writeFileSync } from 'node:fs'
import { Socket } from 'node:net'

const mode = process.env.FAKE_BROWSER_MODE ?? ''
if (process.env.FAKE_BROWSER_ARGS) writeFileSync(process.env.FAKE_BROWSER_ARGS, JSON.stringify(process.argv.slice(2)))
if (mode === 'exit') {
  process.stderr.write('fake browser: cannot open display\n')
  process.exit(3)
}
// Pipe sockets, not fs streams: a blocked fs read on a pipe would keep the process from exiting.
const input = new Socket({ fd: 3, readable: true, writable: false })
const output = new Socket({ fd: 4, readable: false, writable: true })
let buffer = ''
input.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    if (message.method === 'Browser.getVersion') reply(message.id, { product: mode === 'old' ? 'Chrome/100.0.4896.0' : 'Chrome/145.0.7632.6' })
    else if (message.method === 'Browser.close') {
      reply(message.id, {})
      setTimeout(() => process.exit(0), 20)
    } else reply(message.id, {})
  }
})
// Like Chromium: the browser exits when its controller's pipe closes.
input.on('end', () => process.exit(0))

/** @param {number} id @param {Record<string, unknown>} result */
function reply(id, result) {
  output.write(`${JSON.stringify({ id, result })}\0`)
}
