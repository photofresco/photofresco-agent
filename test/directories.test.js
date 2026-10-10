// @ts-check
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Ajv } from '@modelcontextprotocol/client/validators/ajv'
import { buildMcpb, bundleSourceFiles, listServerTools, MANIFEST_VERSION, mcpbFileName, unzip } from '../scripts/build-mcpb.mjs'
import { deeplinks, END, GITHUB_COMMIT, npxArgs, readmeBlock, REPO, serverConfig, SOURCE, START, webLinks } from '../scripts/install-links.mjs'
import { Client, StdioClientTransport } from './support/mcpClient.js'
import { fences } from './support/skillDoc.js'

/**
 * pf-agent-platform-nkwn.35: packaging for MCP directories. Glama (Dockerfile + glama.json), Smithery
 * and Claude Desktop (an MCPB bundle built by scripts/build-mcpb.mjs), Cline (llms-install.md),
 * LobeHub (lhm.plugin.json generated with `npx -y @lobehub/market-cli@0.0.41 plugin init --stdio
 * "node src/bin/photofresco.js mcp"`) and the README's one-click install links
 * (scripts/install-links.mjs). Every manifest carries the package version, the Docker image builds
 * and lists tools over stdio with no network, and the bundle is reproducible and starts the server.
 * Schemas: test/fixtures/mcpb-manifest-v0.3.schema.json (dist/ of @anthropic-ai/mcpb 2.1.2) and
 * test/fixtures/glama-server.schema.json (https://glama.ai/mcp/schemas/server.json, 2026-10-09).
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (/** @type {string} */ file) => readFileSync(join(ROOT, file), 'utf8')
const json = (/** @type {string} */ file) => JSON.parse(read(file))
const PACKAGE = json('package.json')
const SERVER_JSON = json('server.json')
const LISTING = json('assets/listing.json')
const LOBEHUB = json('lhm.plugin.json')
const GLAMA = json('glama.json')
const README = read('README.md')

const work = mkdtempSync(join(tmpdir(), 'pf-directories-test-'))
after(() => rmSync(work, { recursive: true, force: true }))

/** Validate against a JSON Schema fixture (draft-07; its `$schema` key dropped for Ajv). @param {object} value @param {string} fixture */
function validateAgainst(value, fixture) {
  const { $schema: _draft, ...schema } = json(`test/fixtures/${fixture}`)
  const validate = new Ajv({ strict: false, allErrors: true, logger: false }).compile(schema)
  assert.ok(validate(value), `${fixture}: ${JSON.stringify(validate.errors)}`)
}

/** Connect the official MCP client over stdio. @param {string} command @param {string[]} args */
async function connect(command, args) {
  const transport = new StdioClientTransport({ command, args, cwd: work, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work }, stderr: 'pipe' })
  const client = new Client({ name: 'directories-test', version: '1.0.0' })
  await client.connect(transport)
  return client
}

describe('MCP directory packaging', () => {
  it('every manifest carries the package version', async () => {
    assert.equal(SERVER_JSON.version, PACKAGE.version)
    assert.equal(SERVER_JSON.packages[0].version, PACKAGE.version)
    assert.equal(LOBEHUB.version, PACKAGE.version)
    const { manifest } = await buildMcpb({ outDir: join(work, 'version') })
    assert.equal(manifest.version, PACKAGE.version)
    assert.match(readmeBlock('npm'), new RegExp(`npx -y ${PACKAGE.name}@${PACKAGE.version.replaceAll('.', '\\.')} mcp`))
  })

  it('glama.json validates against Glama\'s schema and names the GitHub maintainers', () => {
    validateAgainst(GLAMA, 'glama-server.schema.json')
    assert.equal(GLAMA.$schema, 'https://glama.ai/mcp/schemas/server.json')
    assert.ok(GLAMA.maintainers.length >= 1)
    for (const login of GLAMA.maintainers) assert.match(login, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, login)
  })

  it('the Dockerfile builds from this source with a pinned base image and no install step', () => {
    const dockerfile = read('Dockerfile')
    assert.match(dockerfile, /^FROM node:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}$/m)
    assert.doesNotMatch(dockerfile, /\bnpm (install|ci)\b|\bnpx\b|\bcurl\b|\bwget\b/)
    assert.match(dockerfile, /^ENTRYPOINT \["node", "src\/bin\/photofresco\.js", "mcp"\]$/m)
    assert.match(dockerfile, /^USER node$/m)
    for (const [, sources] of dockerfile.matchAll(/^COPY (.+) \S+$/gm)) for (const source of sources.split(' ')) assert.ok(existsSync(join(ROOT, source)), source)
    // Engines and the base image agree: the image's Node satisfies package.json.
    const [, major] = /^FROM node:(\d+)\./m.exec(dockerfile) ?? []
    assert.ok(Number(major) >= Number(/^>=(\d+)/.exec(PACKAGE.engines.node)?.[1]))
  })

  it('the Docker image builds and answers initialize and tools/list over stdio with no network', { timeout: 600_000 }, async (t) => {
    try {
      execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 20_000 })
    } catch {
      t.skip('docker is not available')
      return
    }
    const tag = `photofresco-mcp-test:${process.pid}`
    const name = `photofresco-mcp-test-${process.pid}`
    execFileSync('docker', ['build', '--quiet', '--tag', tag, ROOT], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 540_000 })
    try {
      const client = await connect('docker', ['run', '--interactive', '--rm', '--network', 'none', '--name', name, tag])
      try {
        assert.deepEqual([client.getServerVersion()?.name, client.getServerVersion()?.version], ['photofresco', PACKAGE.version])
        const names = (await client.listTools()).tools.map((tool) => tool.name)
        for (const tool of ['photofresco_connect', 'photofresco_status', 'doc_get_state', 'render_preview']) assert.ok(names.includes(tool), tool)
        // The image has no browser: connecting fails with the documented code instead of hanging.
        const result = await client.callTool({ name: 'photofresco_connect', arguments: { wait_seconds: 1 } })
        assert.equal(result.isError, true)
        assert.match(JSON.stringify(result), /browser_not_found/)
      } finally {
        await client.close()
      }
    } finally {
      execFileSync('docker', ['rm', '--force', '--volumes', name], { stdio: 'ignore' })
      execFileSync('docker', ['image', 'rm', '--force', tag], { stdio: 'ignore' })
    }
  })

  it('lhm.plugin.json is the market-cli manifest for this server, with the repository\'s identifier', async () => {
    // market-cli's own checks (readPluginManifest), then the documented field rules.
    for (const field of ['identifier', 'name', 'version']) assert.ok(typeof LOBEHUB[field] === 'string' && LOBEHUB[field].trim(), field)
    assert.match(LOBEHUB.identifier, /^[\da-z][\d_a-z-]*$/)
    // `plugin init` derives `<owner>-<repo>` from the GitHub remote; the public repository's.
    assert.equal(LOBEHUB.identifier, new URL(REPO).pathname.slice(1).split('/').join('-'))
    assert.equal(LOBEHUB.name, LISTING.name)
    assert.equal(LOBEHUB.description, LISTING.description)
    assert.equal(LOBEHUB.author, PACKAGE.author.replace(/ <.*$/, ''))
    assert.equal(LOBEHUB.homepage, 'https://photofresco.com/?pf_ref=lobehub')
    assert.deepEqual(LOBEHUB.tags, PACKAGE.keywords)
    for (const key of ['tools', 'resources', 'prompts']) {
      assert.ok(Array.isArray(LOBEHUB[key]) && LOBEHUB[key].every((/** @type {unknown} */ item) => item && typeof item === 'object' && !Array.isArray(item)), key)
    }
    // Regenerate with `plugin init --force` (then restore identifier and homepage) when the tools change.
    assert.deepEqual(LOBEHUB.tools, await listServerTools(), 'lhm.plugin.json tools equal the server\'s tools/list')
    const client = await connect(process.execPath, [join(ROOT, 'src/bin/photofresco.js'), 'mcp'])
    try {
      const templates = (await client.listResourceTemplates()).resourceTemplates
      assert.deepEqual(LOBEHUB.resources.map((/** @type {{ uriTemplate: string }} */ resource) => resource.uriTemplate), templates.map((template) => template.uriTemplate))
    } finally {
      await client.close()
    }
  })

  it('llms-install.md takes an agent from install to connect, doc_get_state and stop', () => {
    const guide = read('llms-install.md')
    for (const fact of [
      'Node.js 22 or newer', 'Chrome', `git clone ${REPO}.git`, 'no `npm install`', '--version',
      'cline_mcp_settings.json', '--read', '--write', 'PHOTOFRESCO_BROWSER',
      'photofresco_connect', 'connection code', '**Allow**', 'photofresco_request_access', '**Permissions**',
      'doc_get_state', 'photofresco_disconnect', '**Stop**', 'PhotoFresco Connector', `photofresco@${PACKAGE.version}`,
    ]) assert.ok(guide.includes(fact), fact)
    const [config] = fences(guide).filter((block) => block.lang === 'json').map((block) => JSON.parse(block.body))
    const server = config.mcpServers.photofresco
    assert.equal(server.command, 'node')
    assert.match(server.args[0], /\/photofresco-agent\/src\/bin\/photofresco\.js$/)
    assert.equal(server.args[1], 'mcp')
    const targets = [...guide.matchAll(/\]\(([^)#]+)\)/g)].map((match) => match[1]).filter((target) => !/^https?:/.test(target))
    for (const target of targets) assert.ok(existsSync(join(ROOT, target)), target)
  })

  it('the README one-click links are generated and each decodes to the documented server entry', () => {
    assert.ok(README.includes(`${readmeBlock()}`), 'README block is current: node scripts/install-links.mjs --write')
    assert.equal(README.indexOf(START), README.lastIndexOf(START))
    assert.ok(README.indexOf(END) > README.indexOf(START))
    assert.match(GITHUB_COMMIT, /^[0-9a-f]{40}$/)
    for (const source of /** @type {const} */ (['github', 'npm'])) {
      const config = serverConfig(source)
      const web = webLinks(source)
      const deep = deeplinks(source)
      const base64 = (/** @type {string} */ link) => JSON.parse(Buffer.from(decodeURIComponent(new URL(link).searchParams.get('config') ?? ''), 'base64').toString('utf8'))
      for (const link of [web.cursor, web.lmstudio, deep.cursor, deep.lmstudio]) {
        assert.equal(new URL(link).searchParams.get('name'), 'photofresco')
        assert.deepEqual(base64(link), config, link)
      }
      for (const link of [web.vscode, web.vscodeInsiders]) {
        assert.deepEqual(JSON.parse(new URL(link).searchParams.get('config') ?? ''), { type: 'stdio', ...config })
      }
      assert.equal(new URL(web.vscodeInsiders).searchParams.get('quality'), 'insiders')
      for (const link of [deep.vscode, deep.vscodeInsiders]) {
        assert.deepEqual(JSON.parse(decodeURIComponent(link.slice(link.indexOf('?') + 1))), { name: 'photofresco', type: 'stdio', ...config })
      }
      assert.equal(config.command, 'npx')
      assert.equal(config.args.at(-1), 'mcp')
    }
    assert.deepEqual(npxArgs('npm'), ['-y', `photofresco@${PACKAGE.version}`, 'mcp'])
    assert.deepEqual(npxArgs('github'), ['-y', `--package=${REPO}/archive/${GITHUB_COMMIT}.tar.gz`, 'photofresco', 'mcp'])
    // Until the npm release, the README's and MCP.md's manual configurations say how to run the same archive.
    if (SOURCE === 'github') {
      for (const [file, text] of [['README.md', README], ['MCP.md', read('MCP.md')]]) {
        assert.ok(text.includes(`\`${npxArgs('github').slice(1, 3).join(' ')}\``), `${file} pending note names the archive form`)
      }
    }
    for (const client of ['Windsurf', 'Gemini CLI', 'Codex', 'Cline', 'MCP Bundle', 'Docker']) assert.ok(README.includes(`**${client}**`), client)
    assert.ok(README.includes(`gemini mcp add -s user photofresco npx -y photofresco@${PACKAGE.version} mcp`))
    assert.ok(README.includes(`codex mcp add photofresco -- npx -y photofresco@${PACKAGE.version} mcp`))
  })

  it('the MCP bundle is reproducible, validates as MCPB 0.3 and starts the server it contains', async () => {
    const first = await buildMcpb({ outDir: join(work, 'mcpb-a') })
    const second = await buildMcpb({ outDir: join(work, 'mcpb-b') })
    assert.equal(first.sha256, second.sha256)
    assert.ok(readFileSync(first.path).equals(readFileSync(second.path)))
    assert.equal(readFileSync(`${first.path}.sha256`, 'utf8'), `${first.sha256}  ${mcpbFileName(PACKAGE.version)}\n`)
    // The release asset name: the Official MCP Registry needs "mcp" in an MCPB package URL.
    assert.equal(mcpbFileName(PACKAGE.version), `photofresco-mcp-${PACKAGE.version}.mcpb`)

    const files = unzip(readFileSync(first.path))
    const manifest = JSON.parse(files.get('manifest.json')?.toString('utf8') ?? '{}')
    validateAgainst(manifest, 'mcpb-manifest-v0.3.schema.json')
    assert.equal(manifest.manifest_version, MANIFEST_VERSION)
    assert.equal(manifest.name, PACKAGE.name)
    assert.equal(manifest.display_name, LISTING.name)
    assert.equal(manifest.description, LISTING.description)
    assert.equal(manifest.license, 'MIT')
    assert.deepEqual(manifest.privacy_policies, ['https://photofresco.com/docs/privacy/'])
    assert.deepEqual(manifest.server.mcp_config, { command: 'node', args: ['${__dirname}/src/bin/photofresco.js', 'mcp'] })
    assert.ok(files.get('icon.png')?.equals(readFileSync(join(ROOT, LISTING.logo))))
    assert.deepEqual([...files.keys()].sort(), ['icon.png', 'manifest.json', ...bundleSourceFiles()].sort())
    assert.ok(![...files.keys()].some((path) => path.startsWith('node_modules/') || path.startsWith('test/')))
    for (const path of bundleSourceFiles()) assert.ok(files.get(path)?.equals(readFileSync(join(ROOT, path))), path)

    // Install the way a client does: unpack, substitute ${__dirname}, start the configured command.
    const installed = join(work, 'installed bundle')
    for (const [path, data] of files) {
      mkdirSync(dirname(join(installed, path)), { recursive: true })
      writeFileSync(join(installed, path), data)
    }
    const args = manifest.server.mcp_config.args.map((/** @type {string} */ arg) => arg.replaceAll('${__dirname}', installed))
    const client = await connect(process.execPath, args)
    try {
      assert.equal(client.getServerVersion()?.version, PACKAGE.version)
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      assert.deepEqual(names, manifest.tools.map((/** @type {{ name: string }} */ tool) => tool.name))
    } finally {
      await client.close()
    }
  })
})
