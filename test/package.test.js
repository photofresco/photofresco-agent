// @ts-check
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fences } from './support/skillDoc.js'

/**
 * pf-agent-platform-nkwn.34: this folder is the public repository photofresco/photofresco-agent and
 * the npm package `photofresco`. Its listing metadata stays consistent (one canonical description and
 * category), the README carries what directories check (prose, install lines, the "What this runs,
 * sends and fetches" disclosure, the skill install line and badge), the assets have the sizes
 * directories require, the release workflow is manual-only and pinned, and `npm pack` ships only the
 * intended files. GitHub's license detection itself (licensee) is recorded in the editor repository.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (/** @type {string} */ file) => readFileSync(join(ROOT, file), 'utf8')
const PACKAGE = JSON.parse(read('package.json'))
const SERVER_JSON = JSON.parse(read('server.json'))
const LISTING = JSON.parse(read('assets/listing.json'))
const README = read('README.md')
const MAX_FILE_BYTES = 256 * 1024
const REPO = 'https://github.com/photofresco/photofresco-agent'

/** Words of prose: code blocks, inline code, HTML tags, link targets and table rules removed. @param {string} text */
function proseWords(text) {
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\|?[\s|:-]+\|?$/gm, ' ')
  return prose.split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word))
}

describe('public repository package', () => {
  it('LICENSE is the MIT license with the recorded copyright holder', () => {
    const license = read('LICENSE')
    assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 PhotoFresco \/ Josh Wardini\n/)
    assert.ok(license.includes('Permission is hereby granted, free of charge, to any person obtaining a copy'))
    assert.ok(license.includes('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND'))
    assert.equal(PACKAGE.license, 'MIT')
    assert.equal(LISTING.license, 'MIT')
  })

  it('package.json carries the public metadata and is publishable (pf-agent-platform-nkwn.39)', () => {
    assert.equal(PACKAGE.name, 'photofresco')
    assert.equal(PACKAGE.homepage, 'https://photofresco.com/')
    assert.equal(PACKAGE.repository.url, `git+${REPO}.git`)
    assert.equal(PACKAGE.bugs.url, `${REPO}/issues`)
    for (const keyword of ['mcp', 'image-editor', 'photoshop-alternative', 'ai-agents']) assert.ok(PACKAGE.keywords.includes(keyword), keyword)
    assert.deepEqual(PACKAGE.bin, { photofresco: 'bin/photofresco.js' })
    assert.match(PACKAGE.engines.node, /^>=\d+/)
    // The owner approved publication (pf-agent-platform-nkwn.39, 2026-10-09): no private flag or note.
    assert.equal(PACKAGE.private, undefined)
    assert.equal(PACKAGE['//'], undefined)
    assert.equal(PACKAGE.mcpName, 'io.github.photofresco/photofresco')
    assert.deepEqual(PACKAGE.files, ['bin', 'src', 'vendor', 'skills', 'server.json', 'CONNECTOR.md', 'DISCLOSURE.md', 'MCP.md', 'CLI.md'])
    // The MCP SDK ships bundled in vendor/ (pf-agent-platform-nkwn.37): the package installs nothing else.
    assert.equal(PACKAGE.dependencies, undefined)
    for (const entry of PACKAGE.files) assert.ok(existsSync(join(ROOT, entry)), entry)
  })

  it('one canonical description and category, reused verbatim', () => {
    assert.ok(LISTING.description.length <= 100, `${LISTING.description.length} characters`)
    assert.equal(SERVER_JSON.description, LISTING.description)
    assert.equal(PACKAGE.description, LISTING.description)
    assert.ok(README.includes(`\n${LISTING.description}\n`), 'README states the description verbatim')
    assert.equal(LISTING.category, 'Design / image editing')
    assert.ok(README.includes(`Category: ${LISTING.category}.`))
    assert.equal(LISTING.repository, REPO)
    assert.equal(SERVER_JSON.repository.url, REPO)
    assert.equal(LISTING.homepage, PACKAGE.homepage)
  })

  it('assets: an exactly 400×400 PNG logo and a demo GIF under the 256 KiB file cap, no video', () => {
    const logo = readFileSync(join(ROOT, LISTING.logo))
    assert.deepEqual([...logo.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature')
    assert.equal(logo.toString('ascii', 12, 16), 'IHDR')
    assert.deepEqual([logo.readUInt32BE(16), logo.readUInt32BE(20)], [400, 400])
    // Claude's plugin directory holds anything but text, images and fonts for review (pf-agent-platform-nkwn.37).
    assert.deepEqual(LISTING.demo, ['assets/demo.gif'])
    assert.equal(readFileSync(join(ROOT, LISTING.demo[0])).toString('ascii', 0, 6), 'GIF89a')
    for (const file of [LISTING.logo, ...LISTING.demo]) assert.ok(statSync(join(ROOT, file)).size <= MAX_FILE_BYTES, file)
  })

  it('README: at least 40 words of prose, install lines for each client, skill line and badge', () => {
    const words = proseWords(README).length
    assert.ok(words >= 40, `${words} words of prose`)
    assert.match(README, /^## What this runs, sends and fetches$/m)
    for (const heading of ['Configure your agent', 'Agent skill', 'Command line', 'Uninstall']) assert.match(README, new RegExp(`^## ${heading}$`, 'm'))
    for (const client of ['Claude Code', 'Claude Desktop', 'Cursor', 'VS Code']) assert.ok(README.includes(`**${client}**`), client)
    assert.ok(README.includes('npx skills add photofresco/photofresco-agent'))
    assert.ok(README.includes('[![skills.sh](https://skills.sh/b/photofresco/photofresco-agent)](https://skills.sh/photofresco/photofresco-agent)'))
    assert.ok(README.includes(`claude mcp add photofresco -- npx -y photofresco@${PACKAGE.version} mcp`))
    const configs = fences(README).filter((block) => block.lang === 'json').map((block) => JSON.parse(block.body))
    assert.deepEqual(configs.map((config) => Object.keys(config)), [['mcpServers'], ['servers']])
    const desktop = configs[0].mcpServers.photofresco
    const vscode = configs[1].servers.photofresco
    assert.deepEqual(vscode, { type: 'stdio', ...desktop })
    assert.deepEqual(desktop.args.slice(0, 3), ['-y', `photofresco@${PACKAGE.version}`, 'mcp'])
    for (const [, version] of README.matchAll(/photofresco@([0-9][^\s"]*)/g)) assert.equal(version, PACKAGE.version)
  })

  it('README links resolve inside the repository', () => {
    const targets = [...README.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)|src="([^"]+)"/g)].map((match) => match[1] ?? match[2]).filter((target) => !/^https?:/.test(target))
    assert.ok(targets.length >= 8)
    for (const target of targets) assert.ok(existsSync(join(ROOT, target)), target)
  })

  it('README disclosure names what DISCLOSURE.md records', () => {
    const section = README.slice(README.indexOf('## What this runs, sends and fetches'), README.indexOf('## Uninstall'))
    for (const fact of [
      '--user-data-dir=<profile> --remote-debugging-pipe --no-first-run --no-default-browser-check',
      'PhotoFresco Connector', 'No listening network port', 'https://photofresco.com/app/?pf_ref=mcp',
      'starts with session recording off', 'unless you turn recording on in Data & privacy', 'a copy of each image opened in the window', "agent's model provider",
      'Spend permission', 'connector.log', 'at most 32 MiB',
    ]) assert.ok(section.includes(fact), fact)
    const disclosure = read('DISCLOSURE.md')
    for (const fact of ['--remote-debugging-pipe --no-first-run --no-default-browser-check --disable-extensions', 'PhotoFresco Connector', 'No listening port', 'Session recording & diagnostics', 'at most 32 MiB', "agent's model provider"]) {
      assert.ok(disclosure.includes(fact), `DISCLOSURE.md: ${fact}`)
    }
  })

  it('the release workflow is manual-only, pinned and publishes with provenance and mcp-publisher', () => {
    const workflow = read('.github/workflows/release.yml')
    assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/m)
    assert.doesNotMatch(workflow, /^ {2}(push|pull_request|pull_request_target|schedule|release):/m)
    assert.match(workflow, /^permissions: \{\}$/m)
    assert.match(workflow, /npm publish --provenance --access public/)
    // io.github.photofresco/* namespace: GitHub OIDC from the photofresco org repo, no DNS key.
    assert.match(workflow, /mcp-publisher login github-oidc/)
    assert.doesNotMatch(workflow, /login dns|MCP_DNS_PRIVATE_KEY/)
    assert.match(workflow, /mcp-publisher publish/)
    assert.match(workflow, /sha256sum --check/)
    // No lockfile in the public repo (pf-agent-platform-nkwn.37), so no `npm ci`.
    assert.doesNotMatch(workflow, /npm ci\b/)
    assert.match(workflow, /npm install --no-save/)
    assert.match(workflow, /environment: release/)
    for (const [, ref] of workflow.matchAll(/uses: [^@\s]+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/, `action pinned by commit SHA: ${ref}`)
  })

  it('npm pack ships only the code, vendored SDK, catalog, skill, server.json and documentation', () => {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    const files = packed.files.map((/** @type {{ path: string }} */ file) => file.path).sort()
    const intended = /^(bin\/[^/]+\.js|src\/.+\.(js|json)|vendor\/([^/]+\.(js|d\.ts|md)|licenses\/[^/]+\.txt)|skills\/.+\.md|server\.json|package\.json|README\.md|LICENSE|(CONNECTOR|DISCLOSURE|MCP|CLI)\.md)$/
    for (const file of files) assert.match(file, intended)
    for (const required of ['bin/photofresco.js', 'src/mcp/server.js', 'src/mcp/catalog/layer.json', 'vendor/mcp-server.js', 'vendor/README.md', 'vendor/licenses/zod.LICENSE.txt', 'skills/photofresco/SKILL.md', 'server.json', 'LICENSE', 'README.md', 'DISCLOSURE.md']) assert.ok(files.includes(required), required)
    for (const file of packed.files) assert.ok(file.size <= MAX_FILE_BYTES, `${file.path} ${file.size} bytes`)
  })
})
