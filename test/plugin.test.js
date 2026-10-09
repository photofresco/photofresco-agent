// @ts-check
import assert from 'node:assert/strict'
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Ajv } from '@modelcontextprotocol/client/validators/ajv'
import { Client, StdioClientTransport } from './support/mcpClient.js'

/**
 * pf-agent-platform-nkwn.37: the repository root is also a plugin for Claude Code
 * (.claude-plugin/plugin.json, .claude-plugin/marketplace.json, .mcp.json), Agent Plugins clients such
 * as Codex (plugin.json, mcp.json), Cursor (.cursor-plugin/plugin.json) and Gemini CLI
 * (gemini-extension.json). Each manifest agrees with package.json and the listing, points at files that
 * exist, and starts the bundled server as `node <plugin root>/src/bin/photofresco.js mcp` (no npx, shell or
 * npm script). The repository stays within Claude's plugin-directory file rules, and every launcher,
 * run from a copy of the repository without node_modules, starts the server and lists its tools.
 * The platforms' own validators (claude plugin validate, gemini extensions validate, codex plugin add)
 * are recorded in the editor repository's evidence.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const json = (/** @type {string} */ file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
const PACKAGE = json('package.json')
const LISTING = json('assets/listing.json')
const REPO = 'https://github.com/photofresco/photofresco-agent'
const HOME = 'https://photofresco.com/'

const CLAUDE = json('.claude-plugin/plugin.json')
const MARKETPLACE = json('.claude-plugin/marketplace.json')
const CLAUDE_MCP = json('.mcp.json')
const AGENT_PLUGIN = json('plugin.json')
const AGENT_MCP = json('mcp.json')
const CURSOR = json('.cursor-plugin/plugin.json')
const GEMINI = json('gemini-extension.json')

/** Each launcher, with the variable its client replaces by the plugin's installed folder. */
const LAUNCHERS = [
  { client: 'Claude Code', file: '.mcp.json', server: CLAUDE_MCP.mcpServers.photofresco, root: '${CLAUDE_PLUGIN_ROOT}/' },
  { client: 'Agent Plugins (Codex)', file: 'mcp.json', server: AGENT_MCP.mcpServers.photofresco, root: '${PLUGIN_ROOT}/' },
  { client: 'Cursor', file: '.cursor-plugin/plugin.json', server: CURSOR.mcpServers.photofresco, root: '${CURSOR_PLUGIN_ROOT}/' },
  { client: 'Gemini CLI', file: 'gemini-extension.json', server: GEMINI.mcpServers.photofresco, root: '${extensionPath}${/}' },
]

/** Every repository file (node_modules and .git excluded), as POSIX paths. @param {string} dir @returns {string[]} */
function repoFiles(dir = ROOT) {
  return readdirSync(dir).sort().flatMap((name) => {
    const full = join(dir, name)
    if (dir === ROOT && (name === 'node_modules' || name === '.git')) return []
    return lstatSync(full).isDirectory() ? repoFiles(full) : [relative(ROOT, full).split(sep).join('/')]
  })
}

const work = mkdtempSync(join(tmpdir(), 'pf-plugin-test-'))
after(() => rmSync(work, { recursive: true, force: true }))

describe('plugin bundle', () => {
  it('every manifest names the plugin photofresco with the package version, description and links', () => {
    for (const [file, manifest] of Object.entries({ '.claude-plugin/plugin.json': CLAUDE, 'plugin.json': AGENT_PLUGIN, '.cursor-plugin/plugin.json': CURSOR, 'gemini-extension.json': GEMINI })) {
      assert.equal(manifest.name, PACKAGE.name, file)
      assert.equal(manifest.version, PACKAGE.version, `${file}: version equals package.json (the release tag)`)
      assert.equal(manifest.description, LISTING.description, file)
      assert.equal(manifest.description, PACKAGE.description, file)
    }
    for (const [file, manifest] of Object.entries({ '.claude-plugin/plugin.json': CLAUDE, 'plugin.json': AGENT_PLUGIN, '.cursor-plugin/plugin.json': CURSOR })) {
      assert.equal(manifest.homepage, HOME, file)
      assert.equal(manifest.repository, REPO, file)
      assert.equal(manifest.license, 'MIT', file)
      assert.deepEqual(manifest.keywords, PACKAGE.keywords, file)
      assert.equal(manifest.author.email, 'hello@photofresco.com', file)
    }
    assert.equal(CLAUDE.displayName, LISTING.name)
    // Claude's directory: lowercase-hyphen name, not one of Anthropic's reserved spellings.
    assert.match(CLAUDE.name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
    assert.doesNotMatch(CLAUDE.name, /claude|anthropic|official|mcp|plugin|test/)
    assert.equal(CLAUDE.documentationUrl, 'https://photofresco.com/docs/ai-agents/')
    assert.equal(CLAUDE.privacyPolicyUrl, 'https://photofresco.com/docs/privacy/')
    assert.equal(CLAUDE.termsOfServiceUrl, 'https://photofresco.com/docs/terms/')
    assert.equal(CLAUDE.supportUrl, `${REPO}/issues`)
  })

  it('the Claude marketplace lists the repository root as the plugin', () => {
    assert.equal(MARKETPLACE.name, 'photofresco')
    assert.equal(MARKETPLACE.owner.name, 'PhotoFresco')
    assert.ok(MARKETPLACE.description)
    assert.deepEqual(MARKETPLACE.plugins, [{ name: CLAUDE.name, source: './', description: LISTING.description, category: 'design' }])
  })

  it('logos and the skill the manifests point at exist; the logo is the listing logo', () => {
    const interfaceOpenAi = AGENT_PLUGIN.extensions['com.openai'].interface
    for (const path of [CLAUDE.icon, CURSOR.logo, interfaceOpenAi.logo, interfaceOpenAi.composerIcon]) {
      assert.equal(path.replace(/^\.\//, ''), LISTING.logo)
      assert.ok(existsSync(join(ROOT, path)), path)
    }
    // Every client discovers skills in skills/<name>/SKILL.md; no manifest overrides the folder.
    assert.ok(existsSync(join(ROOT, 'skills/photofresco/SKILL.md')))
    for (const manifest of [CLAUDE, AGENT_PLUGIN, CURSOR, GEMINI]) assert.equal(manifest.skills, undefined)
    assert.equal(GEMINI.contextFileName, undefined, 'Gemini loads skills/ itself; the skill is not always-on context')
  })

  it('README: an install-as-a-plugin section per client, the folder limit and uninstall lines', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    const section = readme.slice(readme.indexOf('## Install as a plugin'), readme.indexOf('## Agent skill'))
    for (const line of [
      '/plugin marketplace add photofresco/photofresco-agent', `/plugin install ${CLAUDE.name}@${MARKETPLACE.name}`,
      '/plugin install photofresco --marketplace photofresco/photofresco-agent',
      'codex plugin marketplace add photofresco/photofresco-agent', 'codex plugin add photofresco@photofresco',
      'gemini extensions install https://github.com/photofresco/photofresco-agent', '~/.cursor/plugins/local/photofresco',
      'grants **no folders**', 'vendor/README.md',
    ]) assert.ok(section.includes(line), line)
    for (const line of ['/plugin uninstall photofresco@photofresco', 'codex plugin remove photofresco@photofresco', 'gemini extensions uninstall photofresco']) assert.ok(readme.includes(line), line)
  })

  it('the Agent Plugins manifests validate against the standard\'s 1.0.0 schemas, with OpenAI listing limits', () => {
    const ajv = new Ajv({ strict: false, allErrors: true })
    for (const [manifest, schemaFile] of [[AGENT_PLUGIN, 'agent-plugins-plugin.schema.json'], [AGENT_MCP, 'agent-plugins-mcp.schema.json']]) {
      const { $schema: _draft, ...schema } = json(`test/fixtures/${schemaFile}`)
      assert.equal(manifest.$schema, schema.$id)
      const validate = ajv.compile(schema)
      assert.ok(validate(manifest), JSON.stringify(validate.errors))
    }
    const listing = AGENT_PLUGIN.extensions['com.openai'].interface
    assert.ok(listing.displayName.length <= 30 && listing.shortDescription.length <= 30)
    assert.ok(listing.longDescription.length <= 4000)
    assert.ok(listing.capabilities.length <= 20 && listing.capabilities.every((/** @type {string} */ label) => label.length <= 120))
    assert.ok(listing.defaultPrompt.length <= 3 && listing.defaultPrompt.every((/** @type {string} */ prompt) => prompt.length <= 128))
    for (const url of [listing.websiteURL, listing.supportURL]) assert.match(url, /^https:\/\//)
  })

  it('every launcher runs the bundled server file with node and plain arguments', () => {
    for (const { client, server, root } of LAUNCHERS) {
      assert.equal(server.command, 'node', client)
      const sep = root.endsWith('${/}') ? '${/}' : '/'
      assert.deepEqual(server.args, [`${root}src${sep}bin${sep}photofresco.js`, 'mcp'], client)
      assert.equal(server.env, undefined, client)
    }
    assert.equal(AGENT_MCP.mcpServers.photofresco.type, 'stdio')
    for (const file of ['.mcp.json', 'mcp.json']) assert.deepEqual(Object.keys(json(file).mcpServers), ['photofresco'], file)
    assert.deepEqual(Object.keys(CURSOR.mcpServers), ['photofresco'])
    assert.deepEqual(Object.keys(GEMINI.mcpServers), ['photofresco'])
    // The server needs nothing installed: the MCP SDK is bundled in vendor/.
    assert.equal(PACKAGE.dependencies, undefined)
    assert.match(readFileSync(join(ROOT, 'src/mcp/server.js'), 'utf8'), /from '\.\.\/\.\.\/vendor\/mcp-server\.js'/)
  })

  it('the repository meets the plugin directory file rules: ≤512 files, ≤256 KiB, text/images only, readable JS', () => {
    const files = repoFiles()
    assert.ok(files.length <= 512, `${files.length} files`)
    for (const file of files) {
      const full = join(ROOT, file)
      assert.ok(!lstatSync(full).isSymbolicLink(), `${file}: symlink`)
      assert.ok(statSync(full).size <= 256 * 1024, `${file}: ${statSync(full).size} bytes`)
      assert.ok(!/(^|\/)(\.DS_Store|\.npmrc|\.env[^/]*)$/.test(file), file)
      assert.match(file, /(^|\/)(LICENSE|\.gitignore)$|\.(md|js|mjs|ts|json|ya?ml|txt|png|gif)$/, `${file}: only text and image files`)
      if (/\.m?js$/.test(file)) {
        const text = readFileSync(full, 'utf8')
        assert.doesNotMatch(text, /^\s*\/\/[#@] sourceMappingURL=/m, `${file}: source map comment`)
        const longest = Math.max(...text.split('\n').map((line) => line.length))
        assert.ok(longest <= 1000, `${file}: a ${longest}-character line (minified?)`)
      }
    }
    for (const file of files.filter((path) => path.startsWith('vendor/') && path.endsWith('.js'))) {
      assert.match(readFileSync(join(ROOT, file), 'utf8'), /^\/\/ Generated by scripts\/agent-vendor\.mjs from @modelcontextprotocol\/server /, file)
    }
    assert.ok(files.includes('vendor/README.md') && files.some((file) => file.startsWith('vendor/licenses/')))
  })

  it('each launcher, run from a copy without node_modules, starts the server and lists its tools', async () => {
    const pluginRoot = join(work, 'installed plugin')
    cpSync(ROOT, pluginRoot, { recursive: true, filter: (source) => !/[\\/](node_modules|\.git|test|package-lock\.json)$/.test(source) })
    // The public repo has no lockfile and nothing installed (pf-agent-platform-nkwn.37).
    assert.ok(!existsSync(join(pluginRoot, 'node_modules')) && !existsSync(join(pluginRoot, 'package-lock.json')))
    for (const { client, server, root } of LAUNCHERS) {
      const expand = (/** @type {string} */ arg) => arg.replaceAll(root, `${pluginRoot}/`).replaceAll('${/}', '/')
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: server.args.map(expand),
        cwd: work, // not the plugin root: the server finds its files from its own path
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work },
        stderr: 'pipe',
      })
      const mcp = new Client({ name: `plugin-launcher-test (${client})`, version: '1.0.0' })
      await mcp.connect(transport)
      try {
        assert.equal(mcp.getServerVersion()?.name, 'photofresco', client)
        assert.equal(mcp.getServerVersion()?.version, PACKAGE.version, client)
        const names = (await mcp.listTools()).tools.map((tool) => tool.name)
        for (const name of ['photofresco_connect', 'photofresco_status', 'doc_get_state', 'render_preview']) assert.ok(names.includes(name), `${client}: ${name}`)
      } finally {
        await mcp.close()
      }
    }
  })
})
