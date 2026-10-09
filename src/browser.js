// @ts-check
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { CdpConnection } from './cdp.js'
import { ConnectorError } from './errors.js'

/**
 * The connector's own browser (pf-agent-platform-nkwn.14): an installed Chromium-based
 * browser started as a separate process with a dedicated profile directory and the
 * DevTools protocol on a private pipe. The user's normal browser, its profiles and its
 * running windows are never opened, read or attached to.
 */

/** Oldest Chromium major the connector starts (CDP bindings, pipe transport, the editor's platform needs). */
export const MIN_BROWSER_MAJOR = 120

export const BROWSER_TIMEOUTS = Object.freeze({
  /** Browser process start until the protocol answers. */
  launchMs: 30_000,
  /** Graceful close before the process is killed. */
  closeMs: 5_000,
})

const LOCK_FILE = 'PhotoFrescoConnector.lock'

/**
 * Exactly what the connector passes to the browser (besides the executable). Documented
 * in DISCLOSURE.md; a test pins it.
 * @param {string} profileDir
 * @returns {string[]}
 */
export function browserArguments(profileDir) {
  return [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ]
}

/**
 * Default per-user data directory (profile, lock). Removing it is the clean uninstall.
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function defaultDataDir(platform = process.platform, env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir()
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'PhotoFresco Connector')
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'PhotoFresco Connector')
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'photofresco-connector')
}

/**
 * Installed browsers the connector looks for, in order. Stable channels of Google Chrome,
 * Microsoft Edge and Chromium only; anything else must be named explicitly.
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function browserCandidates(platform = process.platform, env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir()
  if (platform === 'darwin') {
    const apps = [
      ['Google Chrome', 'Google Chrome'],
      ['Microsoft Edge', 'Microsoft Edge'],
      ['Chromium', 'Chromium'],
    ]
    return apps.flatMap(([app, binary]) => [
      `/Applications/${app}.app/Contents/MacOS/${binary}`,
      join(home, 'Applications', `${app}.app`, 'Contents', 'MacOS', binary),
    ])
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((root) => !!root)
    return [
      ...roots.map((root) => join(/** @type {string} */ (root), 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map((root) => join(/** @type {string} */ (root), 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ]
  }
  const names = ['google-chrome-stable', 'google-chrome', 'microsoft-edge-stable', 'microsoft-edge', 'chromium', 'chromium-browser']
  const dirs = (env.PATH || '/usr/local/bin:/usr/bin:/bin').split(delimiter).filter(Boolean)
  return names.flatMap((name) => dirs.map((dir) => join(dir, name)))
}

/**
 * Which browser executable to run: the `browserPath` option, then `PHOTOFRESCO_BROWSER`,
 * then the first installed candidate. Nothing is downloaded.
 * @param {{ browserPath?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, exists?: (path: string) => boolean }} [options]
 * @returns {{ path: string, source: 'option' | 'env' | 'discovered' }}
 */
export function findBrowser(options = {}) {
  const env = options.env ?? process.env
  const exists = options.exists ?? isExecutableFile
  const explicit = options.browserPath ? { path: options.browserPath, source: /** @type {const} */ ('option') }
    : env.PHOTOFRESCO_BROWSER ? { path: env.PHOTOFRESCO_BROWSER, source: /** @type {const} */ ('env') } : null
  if (explicit) {
    if (!exists(explicit.path)) {
      throw new ConnectorError('browser_not_found', `The browser ${explicit.source === 'env' ? 'in PHOTOFRESCO_BROWSER' : 'set in browserPath'} does not exist or is not a file: ${explicit.path}`)
    }
    return explicit
  }
  for (const candidate of browserCandidates(options.platform, env)) {
    if (exists(candidate)) return { path: candidate, source: 'discovered' }
  }
  throw new ConnectorError('browser_not_found',
    'No Google Chrome, Microsoft Edge or Chromium installation was found. Install one, or set PHOTOFRESCO_BROWSER to a Chromium-based browser executable (for example Chrome for Testing).')
}

/** @param {string} path */
function isExecutableFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** @param {string} product Browser.getVersion product, e.g. "Chrome/145.0.7632.6" */
export function browserMajor(product) {
  const match = /\/(\d+)\.\d+/.exec(product)
  return match ? Number(match[1]) : null
}

/**
 * Hold the profile for this process. A lock left by a process that no longer runs is replaced.
 * @param {string} profileDir
 * @returns {() => void} release
 */
export function lockProfile(profileDir) {
  const path = join(profileDir, LOCK_FILE)
  // "<pid> <nonce>": another connector in this same process holds a different nonce.
  const token = `${process.pid} ${randomBytes(8).toString('hex')}`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      writeSync(fd, token)
      closeSync(fd)
      return () => {
        try {
          if (readFileSync(path, 'utf8') === token) unlinkSync(path)
        } catch {
          // Already gone.
        }
      }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') {
        throw new ConnectorError('browser_launch_failed', `The browser profile ${profileDir} is not writable: ${/** @type {Error} */ (error).message}`)
      }
      const owner = Number.parseInt(safeRead(path), 10)
      if (Number.isSafeInteger(owner) && owner > 0 && processAlive(owner)) {
        throw new ConnectorError('profile_in_use',
          `Another PhotoFresco connector (process ${owner}) is using the browser profile ${profileDir}. Stop it, or use an ephemeral profile.`)
      }
      try {
        unlinkSync(path)
      } catch {
        // Raced with another remover; retry once.
      }
    }
  }
  throw new ConnectorError('profile_in_use', `The browser profile ${profileDir} is locked`)
}

/** @param {string} path */
function safeRead(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** @param {number} pid */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM'
  }
}

/**
 * @typedef {object} LaunchOptions
 * @property {string} executable
 * @property {string} profileDir Dedicated profile, or 'ephemeral' for a temporary one deleted on exit.
 * @property {(entry: Record<string, unknown>) => void} [log]
 * @property {boolean} [headless] Test harnesses only: no on-screen window. The connector itself always opens a visible one.
 *
 * @typedef {object} BrowserProcess
 * @property {CdpConnection} cdp
 * @property {number} pid
 * @property {string} product
 * @property {string} executable
 * @property {string} profileDir
 * @property {boolean} ephemeral
 * @property {readonly string[]} args
 * @property {Promise<void>} exited Resolves when the browser process has exited.
 * @property {() => boolean} running
 * @property {() => Promise<void>} close Graceful Browser.close, then kill after a timeout.
 */

/**
 * Start the browser with the dedicated profile and wait until the protocol answers.
 * @param {LaunchOptions} options
 * @returns {Promise<BrowserProcess>}
 */
export async function launchBrowser(options) {
  const ephemeral = options.profileDir === 'ephemeral'
  const profileDir = ephemeral ? mkdtempSync(join(tmpdir(), 'photofresco-connector-')) : options.profileDir
  if (!ephemeral) mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  const releaseLock = ephemeral ? () => {} : lockProfile(profileDir)
  const args = options.headless ? ['--headless=new', ...browserArguments(profileDir)] : browserArguments(profileDir)
  /** @type {import('node:child_process').ChildProcess} */
  let child
  try {
    child = spawn(options.executable, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: false })
  } catch (error) {
    releaseLock()
    throw new ConnectorError('browser_launch_failed', `Could not start ${options.executable}: ${/** @type {Error} */ (error).message}`)
  }
  let stderrTail = ''
  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096)
  })
  let exited = false
  const exitedPromise = new Promise((resolve) => {
    const finish = () => {
      if (exited) return
      exited = true
      releaseLock()
      if (ephemeral) rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 })
      resolve(undefined)
    }
    child.once('exit', finish)
    child.once('error', finish)
  })
  const cdp = new CdpConnection(/** @type {NodeJS.WritableStream} */ (child.stdio[3]), /** @type {NodeJS.ReadableStream} */ (child.stdio[4]))
  child.once('exit', () => cdp.close('browser exited'))

  /** @type {NodeJS.Timeout | undefined} */
  let timer
  try {
    const version = await Promise.race([
      cdp.send('Browser.getVersion'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), BROWSER_TIMEOUTS.launchMs) }),
      exitedPromise.then(() => { throw new Error('exited during startup') }),
    ])
    const major = browserMajor(version.product ?? '')
    if (major === null || major < MIN_BROWSER_MAJOR) {
      throw new ConnectorError('browser_unsupported', `${version.product ?? 'The browser'} is older than the supported Chromium ${MIN_BROWSER_MAJOR}; update it or set PHOTOFRESCO_BROWSER`)
    }
    options.log?.({ event: 'browser_started', pid: child.pid, product: version.product, executable: options.executable, profile: ephemeral ? 'ephemeral' : profileDir })
    const close = async () => {
      if (exited) return
      cdp.send('Browser.close').catch(() => {})
      /** @type {NodeJS.Timeout | undefined} */
      let killTimer
      await Promise.race([exitedPromise, new Promise((resolve) => { killTimer = setTimeout(resolve, BROWSER_TIMEOUTS.closeMs) })])
      clearTimeout(killTimer)
      if (!exited) {
        child.kill('SIGKILL')
        await exitedPromise
      }
    }
    return {
      cdp,
      pid: /** @type {number} */ (child.pid),
      product: version.product,
      executable: options.executable,
      profileDir: ephemeral ? 'ephemeral' : profileDir,
      ephemeral,
      args: Object.freeze([...args]),
      exited: exitedPromise,
      running: () => !exited,
      close,
    }
  } catch (error) {
    if (!exited) child.kill('SIGKILL')
    await exitedPromise
    if (error instanceof ConnectorError) throw error
    let hint = ''
    try {
      lstatSync(join(profileDir, 'SingletonLock'))
      hint = ' A browser may still be running with this profile.'
    } catch {
      // No lock left behind.
    }
    throw new ConnectorError('browser_launch_failed',
      `${options.executable} did not start (${/** @type {Error} */ (error).message}).${hint}${stderrTail ? ` Browser output: ${stderrTail.trim().slice(-600)}` : ''}`)
  } finally {
    clearTimeout(timer)
  }
}
