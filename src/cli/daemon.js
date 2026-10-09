// @ts-check
import { spawn } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createConnector } from '../connector.js'
import { ConnectorError } from '../errors.js'
import { attachPaths, ensurePrivateDir, startAttachServer } from './attach.js'

/**
 * The background connector process behind the CLI (pf-agent-platform-nkwn.16). `photofresco
 * connect` starts it when none runs for the data folder; it owns one connector (surface `cli`),
 * the browser window that connector opens and the paired session, and serves them on the private
 * socket (attach.js). It ends when a client calls `shutdown` (`photofresco stop`), when the user
 * closes the connector's browser, on SIGINT/SIGTERM/SIGHUP, or after a minute with no browser
 * and no client.
 */

export const DAEMON_LIMITS = Object.freeze({
  /** With no browser and no client this long, the process exits. */
  idleExitMs: 60_000,
  /** `connect` waits this long for a spawned process to listen. */
  spawnReadyMs: 15_000,
  /** The connector log stops growing past this size (it restarts empty with each process). */
  maxLogBytes: 4 * 1024 * 1024,
})

/** Environment variable carrying the spawned process's configuration. */
export const DAEMON_CONFIG_ENV = 'PHOTOFRESCO_CLI_DAEMON'

/**
 * @typedef {object} DaemonConfig
 * @property {string} dataDir
 * @property {string} [profileDir]
 * @property {string} [browserPath]
 * @property {string} [editorUrl]
 * @property {boolean} [allowLoopbackEditor]
 */

/**
 * Secret-free connector diagnostics (CONNECTOR.md `log`) as JSON lines in `<data>/cli/connector.log`.
 * @param {string} path
 * @returns {(entry: Record<string, unknown>) => void}
 */
function fileLog(path) {
  /** @type {number | null} */
  let fd = openSync(path, 'w', 0o600)
  let written = 0
  process.once('exit', () => { if (fd !== null) closeSync(fd) })
  return (entry) => {
    if (fd === null) return
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`
    written += Buffer.byteLength(line)
    try {
      if (written > DAEMON_LIMITS.maxLogBytes) {
        writeSync(fd, `${JSON.stringify({ ts: new Date().toISOString(), event: 'log_truncated' })}\n`)
        closeSync(fd)
        fd = null
        return
      }
      writeSync(fd, line)
    } catch {
      fd = null
    }
  }
}

/**
 * @typedef {object} Daemon
 * @property {import('../connector.js').Connector} connector
 * @property {import('./attach.js').AttachServer} server
 * @property {() => Promise<void>} stop End the session, close the browser, stop listening.
 * @property {Promise<void>} stopped Resolves once stopped.
 */

/**
 * Start a connector process for a data folder in this process (also the in-process seam used by
 * the editor repository's integration tests and the headless end-to-end harness).
 * @param {object} options
 * @param {string} options.dataDir
 * @param {Partial<import('../connector.js').ConnectorOptions>} [options.connector] Browser options and test seams (launch).
 * @param {import('../connector.js').Connector} [options.instance] Serve this connector (surface `cli`) instead of creating one; in-process callers and tests.
 * @param {((entry: Record<string, unknown>) => void) | null} [options.log] Default: the data folder's connector.log; null: none.
 * @param {number} [options.idleExitMs]
 * @returns {Promise<Daemon>}
 */
export async function startDaemon(options) {
  const paths = attachPaths(options.dataDir)
  ensurePrivateDir(paths.dir)
  const log = options.log === null ? () => {} : options.log ?? fileLog(paths.log)
  const connector = options.instance ?? createConnector({ client: 'Terminal', dataDir: paths.dataDir, ...options.connector, surface: 'cli', log })
  if (connector.surface !== 'cli') throw new ConnectorError('invalid_options', 'The CLI connector process serves a connector with surface "cli"')
  const idleExitMs = options.idleExitMs ?? DAEMON_LIMITS.idleExitMs
  /** @type {(value?: unknown) => void} */
  let markStopped = () => {}
  const stopped = new Promise((resolveStopped) => { markStopped = resolveStopped })
  /** @type {NodeJS.Timeout | undefined} */
  let idleTimer
  /** @type {Promise<void> | null} */
  let stopping = null
  /** @type {import('./attach.js').AttachServer | null} */
  let server = null
  let hadBrowser = false

  const stop = () => {
    stopping ??= (async () => {
      clearTimeout(idleTimer)
      off()
      await connector.shutdown().catch(() => {})
      await server?.close()
      log({ event: 'connector_process_stopped' })
      markStopped()
    })()
    return stopping
  }
  const checkIdle = () => {
    clearTimeout(idleTimer)
    if (stopping || !server) return
    if (connector.status().state === 'idle' && server.clients() === 0) idleTimer = setTimeout(() => void stop(), idleExitMs)
  }
  const off = connector.subscribe((event) => {
    if (event.type !== 'state') return
    if (event.state === 'ready' || event.state === 'pairing' || event.state === 'connected') hadBrowser = true
    // The user closed the connector's browser: nothing is left to attach to.
    if (event.state === 'idle' && hadBrowser) {
      log({ event: 'browser_gone_exiting' })
      void stop()
      return
    }
    checkIdle()
  })
  server = await startAttachServer({ connector, paths, onShutdown: () => void stop(), onClients: checkIdle }).catch((error) => {
    off()
    throw error
  })
  log({ event: 'connector_process_started', pid: process.pid })
  checkIdle()
  return { connector, server, stop, stopped: /** @type {Promise<void>} */ (stopped) }
}

/**
 * Entry of the spawned process (`photofresco __daemon`): configuration from DAEMON_CONFIG_ENV,
 * readiness reported over the IPC channel, then the channel is closed so the parent can exit.
 */
export async function runDaemonProcess() {
  /** @type {DaemonConfig} */
  const config = JSON.parse(process.env[DAEMON_CONFIG_ENV] ?? '{}')
  const report = (/** @type {Record<string, unknown>} */ message) => {
    if (process.send && process.connected) process.send(message)
    if (process.connected) process.disconnect()
  }
  /** @type {Daemon} */
  let daemon
  try {
    if (typeof config.dataDir !== 'string' || !config.dataDir) throw new ConnectorError('invalid_options', 'The connector process needs a data folder')
    daemon = await startDaemon({
      dataDir: config.dataDir,
      connector: {
        ...(config.profileDir !== undefined ? { profileDir: config.profileDir } : {}),
        ...(config.browserPath !== undefined ? { browserPath: config.browserPath } : {}),
        ...(config.editorUrl !== undefined ? { editorUrl: config.editorUrl } : {}),
        allowLoopbackEditor: config.allowLoopbackEditor === true,
      },
    })
  } catch (error) {
    report({ ready: false, error: error instanceof ConnectorError ? error.toJSON() : { code: 'internal_error', message: String(/** @type {Error} */ (error)?.message ?? error) } })
    process.exitCode = 1
    return
  }
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.once(signal, () => void daemon.stop())
  report({ ready: true, pid: process.pid })
  await daemon.stopped
  process.exit(0)
}

/**
 * Start the background connector process for a data folder and wait until it listens.
 * `already_running` (another invocation won the race) counts as success.
 * @param {DaemonConfig} config
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<void>}
 */
export function spawnDaemon(config, env) {
  const bin = fileURLToPath(new URL('../bin/photofresco.js', import.meta.url))
  const child = spawn(process.execPath, [bin, '__daemon'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...env, [DAEMON_CONFIG_ENV]: JSON.stringify(config) },
    cwd: homedir(),
    windowsHide: true,
  })
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => finish(new ConnectorError('ipc_failed', `The connector process did not start within ${DAEMON_LIMITS.spawnReadyMs / 1000} s`)), DAEMON_LIMITS.spawnReadyMs)
    /** @param {Error | null} error */
    const finish = (error) => {
      clearTimeout(timer)
      child.removeAllListeners()
      if (child.connected) child.disconnect()
      child.unref()
      if (error) rejectReady(error)
      else resolveReady()
    }
    child.once('message', (/** @type {any} */ message) => {
      if (message?.ready) return finish(null)
      const error = message?.error ?? {}
      if (error.code === 'already_running') return finish(null)
      finish(new ConnectorError(typeof error.code === 'string' ? error.code : 'ipc_failed', String(error.message ?? 'The connector process failed to start')))
    })
    child.once('error', (error) => finish(new ConnectorError('ipc_failed', `Could not start the connector process: ${error.message}`)))
    child.once('exit', (code) => finish(new ConnectorError('ipc_failed', `The connector process exited during startup (code ${code})`)))
  })
}
