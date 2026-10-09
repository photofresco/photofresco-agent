// @ts-check
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import { MIN_BROWSER_MAJOR, browserArguments, browserCandidates, browserMajor, defaultDataDir, findBrowser, launchBrowser, lockProfile } from '../src/browser.js'

const FAKE = new URL('./fixtures/fake-browser.mjs', import.meta.url).pathname
const base = mkdtempSync(join(tmpdir(), 'pf-connector-browser-'))
after(() => rmSync(base, { recursive: true, force: true }))
afterEach(() => {
  delete process.env.FAKE_BROWSER_MODE
  delete process.env.FAKE_BROWSER_ARGS
})
const posix = process.platform !== 'win32'

describe('browser selection', () => {
  it('passes a dedicated profile and a private pipe, never a debugging port', () => {
    assert.deepEqual(browserArguments('/data/profile'), [
      '--user-data-dir=/data/profile',
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank',
    ])
    assert.equal(browserArguments('/p').some((arg) => arg.startsWith('--remote-debugging-port') || arg.startsWith('--remote-debugging-address')), false)
  })

  it('looks for stable Chrome, Edge and Chromium installs per OS', () => {
    assert.deepEqual(browserCandidates('darwin', { HOME: '/Users/a' }).slice(0, 2), [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Users/a/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ])
    assert.ok(browserCandidates('darwin', { HOME: '/Users/a' }).includes('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'))
    const windows = browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })
    assert.ok(windows.some((path) => path.endsWith('chrome.exe')) && windows.some((path) => path.endsWith('msedge.exe')))
    assert.deepEqual(browserCandidates('linux', { PATH: '/usr/bin' }).slice(0, 2), ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'])
  })

  it('prefers the option, then PHOTOFRESCO_BROWSER, then an installed browser; downloads nothing', () => {
    const exists = (/** @type {string} */ path) => path === '/opt/chrome' || path === '/usr/bin/chromium'
    assert.deepEqual(findBrowser({ browserPath: '/opt/chrome', env: { PHOTOFRESCO_BROWSER: '/x' }, exists }), { path: '/opt/chrome', source: 'option' })
    assert.deepEqual(findBrowser({ env: { PHOTOFRESCO_BROWSER: '/opt/chrome' }, exists }), { path: '/opt/chrome', source: 'env' })
    assert.deepEqual(findBrowser({ env: { PATH: '/usr/bin' }, platform: 'linux', exists }), { path: '/usr/bin/chromium', source: 'discovered' })
    assert.throws(() => findBrowser({ env: { PHOTOFRESCO_BROWSER: '/missing' }, exists }), { code: 'browser_not_found' })
    assert.throws(() => findBrowser({ env: { PATH: '/nowhere' }, platform: 'linux', exists }), { code: 'browser_not_found', message: /PHOTOFRESCO_BROWSER/ })
  })

  it('parses the Chromium major and keeps per-OS data folders', () => {
    assert.equal(browserMajor('Chrome/145.0.7632.6'), 145)
    assert.equal(browserMajor('HeadlessChrome/120.0.1.1'), 120)
    assert.equal(browserMajor('nonsense'), null)
    assert.equal(defaultDataDir('darwin', { HOME: '/Users/a' }), '/Users/a/Library/Application Support/PhotoFresco Connector')
    assert.equal(defaultDataDir('linux', { HOME: '/home/a' }), '/home/a/.local/share/photofresco-connector')
    assert.equal(defaultDataDir('linux', { HOME: '/home/a', XDG_DATA_HOME: '/xdg' }), '/xdg/photofresco-connector')
  })

  it('holds the profile for one connector and replaces a stale lock', () => {
    const profile = mkdtempSync(join(base, 'lock-'))
    const lock = join(profile, 'PhotoFrescoConnector.lock')
    const release = lockProfile(profile)
    assert.throws(() => lockProfile(profile), { code: 'profile_in_use' }, 'a second connector in the same process')
    // Another live process holds it (this process's parent stands in for a second connector).
    writeFileSync(lock, `${process.ppid} 00`)
    assert.throws(() => lockProfile(profile), { code: 'profile_in_use' })
    writeFileSync(lock, '99999999 00')
    const again = lockProfile(profile)
    assert.match(readFileSync(lock, 'utf8'), new RegExp(`^${process.pid} [0-9a-f]{16}$`))
    release()
    assert.equal(existsSync(lock), true, 'releasing a replaced lock leaves the new holder alone')
    again()
    assert.equal(existsSync(lock), false)
  })
})

describe('browser launch', { skip: !posix && 'fake browser fixture needs a POSIX shebang' }, () => {
  it('starts the browser over the pipe, records its arguments and closes it', async () => {
    const profile = join(base, 'profile-ok')
    process.env.FAKE_BROWSER_ARGS = join(base, 'args.json')
    const browser = await launchBrowser({ executable: FAKE, profileDir: profile })
    try {
      assert.equal(browser.product, 'Chrome/145.0.7632.6')
      assert.deepEqual(JSON.parse(readFileSync(join(base, 'args.json'), 'utf8')), browserArguments(profile))
      assert.throws(() => lockProfile(profile), { code: 'profile_in_use' }, 'a second connector cannot share the profile')
      await assert.rejects(launchBrowser({ executable: FAKE, profileDir: profile }), { code: 'profile_in_use' })
    } finally {
      await browser.close()
    }
    assert.equal(browser.running(), false)
    assert.equal(existsSync(join(profile, 'PhotoFrescoConnector.lock')), false)
  })

  it('removes an ephemeral profile when the browser exits', async () => {
    process.env.FAKE_BROWSER_ARGS = join(base, 'args-ephemeral.json')
    const browser = await launchBrowser({ executable: FAKE, profileDir: 'ephemeral' })
    try {
      const [flag] = JSON.parse(readFileSync(join(base, 'args-ephemeral.json'), 'utf8'))
      const dir = flag.slice('--user-data-dir='.length)
      assert.ok(existsSync(dir))
      await browser.close()
      assert.equal(existsSync(dir), false)
    } finally {
      await browser.close()
    }
  })

  it(`refuses a browser older than Chromium ${MIN_BROWSER_MAJOR} and stops it`, async () => {
    process.env.FAKE_BROWSER_MODE = 'old'
    const profile = join(base, 'profile-old')
    await assert.rejects(launchBrowser({ executable: FAKE, profileDir: profile }), { code: 'browser_unsupported', message: /Chrome\/100/ })
    assert.equal(existsSync(join(profile, 'PhotoFrescoConnector.lock')), false)
  })

  it('reports a browser that exits during startup with its output', async () => {
    process.env.FAKE_BROWSER_MODE = 'exit'
    await assert.rejects(launchBrowser({ executable: FAKE, profileDir: join(base, 'profile-exit') }), { code: 'browser_launch_failed', message: /cannot open display/ })
  })
})
