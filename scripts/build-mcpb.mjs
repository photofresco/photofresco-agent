#!/usr/bin/env node
// @ts-check
/**
 * Build the MCP Bundle (pf-agent-platform-nkwn.35): `dist/photofresco-mcp-<version>.mcpb` plus its `.sha256`.
 *
 *   node scripts/build-mcpb.mjs [--out <folder>]
 *
 * An MCPB file is a zip with manifest.json (MCPB manifest 0.3,
 * https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md) and the server. Claude Desktop
 * opens it to install the server, and Smithery publishes local servers from it. The server needs no
 * node_modules (the MCP SDK is bundled in vendor/), so the bundle is package.json, LICENSE,
 * DISCLOSURE.md, src/ and vendor/ plus the manifest and icon. The manifest lists the tools the server
 * itself reports before connecting (it adds tools as the user grants permissions: tools_generated).
 *
 * Reproducible: entries are sorted, timestamps fixed (1980-01-01) and modes 0644, so the same source
 * and Node.js version produce the same bytes and SHA-256. Validate with the official CLI:
 * `npx -y @anthropic-ai/mcpb@2.1.2 info dist/photofresco-mcp-<version>.mcpb`. The file is also the
 * GitHub Release asset that server.json's `mcpb` package points at (Official MCP Registry); its name
 * must contain "mcp", and server.json's `fileSha256` must equal the hash printed here.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const MANIFEST_VERSION = '0.3'
const REPO = 'https://github.com/photofresco/photofresco-agent'

/** File name of the bundle for `version`: the GitHub Release asset name. @param {string} version */
export const mcpbFileName = (version) => `photofresco-mcp-${version}.mcpb`
/** Where the release `v<version>` serves the bundle (server.json's mcpb package identifier). @param {string} version */
export const mcpbReleaseUrl = (version) => `${REPO}/releases/download/v${version}/${mcpbFileName(version)}`

const json = (/** @type {string} */ file, root = ROOT) => JSON.parse(readFileSync(join(root, file), 'utf8'))

/** Files of `dir` (recursive), POSIX paths relative to `root`. @param {string} root @param {string} dir @returns {string[]} */
function listFiles(root, dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    return entry.isDirectory() ? listFiles(root, path) : [path]
  })
}

/** Repository files that go into the bundle, sorted. @param {string} [root] */
export function bundleSourceFiles(root = ROOT) {
  const files = [
    'package.json', 'LICENSE', 'DISCLOSURE.md',
    ...listFiles(root, 'src').filter((path) => /\.(js|json)$/.test(path)),
    ...listFiles(root, 'vendor').filter((path) => /\.(js|md|txt)$/.test(path)),
  ]
  return files.map((path) => path.split(sep).join('/')).sort()
}

/**
 * Start the server over stdio and return its tools/list (no browser starts before photofresco_connect).
 * @param {string} [root]
 * @returns {Promise<{ name: string, description?: string }[]>}
 */
export function listServerTools(root = ROOT) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(root, 'src/bin/photofresco.js'), 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] })
    const timer = setTimeout(() => { child.kill(); reject(new Error('The MCP server did not answer tools/list within 20 seconds')) }, 20_000)
    let buffer = ''
    const send = (/** @type {object} */ message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    child.on('error', reject)
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        const message = JSON.parse(line)
        if (message.id === 1) {
          send({ method: 'notifications/initialized' })
          send({ id: 2, method: 'tools/list', params: {} })
        } else if (message.id === 2) {
          clearTimeout(timer)
          child.stdin.end()
          child.kill()
          if (message.error) reject(new Error(`tools/list failed: ${message.error.message}`))
          else resolvePromise(message.result.tools)
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'photofresco-mcpb-build', version: '1.0.0' } } })
  })
}

/** The MCPB manifest. @param {{ name: string, description?: string }[]} tools @param {string} [root] */
export function mcpbManifest(tools, root = ROOT) {
  const pkg = json('package.json', root)
  const listing = json('assets/listing.json', root)
  return {
    manifest_version: MANIFEST_VERSION,
    name: pkg.name,
    display_name: listing.name,
    version: pkg.version,
    description: listing.description,
    long_description: [
      'PhotoFresco lets your agent edit images in a PhotoFresco editor window on your computer: layers, masks,',
      'selections, adjustment layers, crop and resize, previews, undo and export. You approve the connection',
      'and each permission in the window and watch every edit. It needs Chrome, Edge or Chromium 120 or newer.',
      'This bundle grants the agent no folders: open images in the window yourself, or configure the server',
      'with --read and --write folders (see the README) to let the agent open and save files.',
    ].join(' '),
    author: { name: 'PhotoFresco / Josh Wardini', email: 'hello@photofresco.com', url: 'https://photofresco.com/' },
    repository: { type: 'git', url: REPO },
    homepage: 'https://photofresco.com/?pf_ref=smithery',
    documentation: 'https://photofresco.com/docs/ai-agents/',
    support: `${REPO}/issues`,
    icon: 'icon.png',
    server: {
      type: 'node',
      entry_point: 'src/bin/photofresco.js',
      mcp_config: { command: 'node', args: ['${__dirname}/src/bin/photofresco.js', 'mcp'] },
    },
    tools: tools.map(({ name, description }) => ({ name, ...(description ? { description: description.split('\n')[0] } : {}) })),
    tools_generated: true,
    keywords: pkg.keywords,
    license: pkg.license,
    privacy_policies: ['https://photofresco.com/docs/privacy/'],
    compatibility: {
      platforms: ['darwin', 'win32', 'linux'],
      runtimes: { node: pkg.engines.node.replace(/^>=(\d+)$/, '>=$1.0.0') },
    },
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
/** @param {Buffer} bytes */
function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const DOS_DATE = (0 << 9) | (1 << 5) | 1 // 1980-01-01
const DOS_TIME = 0

/** A deterministic zip of `entries` (deflated, UTF-8 names, mode 0644, fixed timestamps). @param {{ path: string, data: Buffer }[]} entries */
export function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { path, data } of entries) {
    const name = Buffer.from(path, 'utf8')
    const deflated = deflateRawSync(data, { level: 9 })
    const stored = deflated.length >= data.length
    const body = stored ? data : deflated
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made by Unix, zip 2.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** Entries of a zip written by `zip` (or any zip without data descriptors), by path. @param {Buffer} archive */
export function unzip(archive) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) throw new Error('Not a zip file')
  const count = archive.readUInt16LE(end + 10)
  let at = archive.readUInt32LE(end + 16)
  /** @type {Map<string, Buffer>} */
  const files = new Map()
  for (let index = 0; index < count; index++) {
    const method = archive.readUInt16LE(at + 10)
    const size = archive.readUInt32LE(at + 20)
    const nameLength = archive.readUInt16LE(at + 28)
    const extra = archive.readUInt16LE(at + 30)
    const comment = archive.readUInt16LE(at + 32)
    const local = archive.readUInt32LE(at + 42)
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength)
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28)
    const body = archive.subarray(start, start + size)
    files.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body))
    at += 46 + nameLength + extra + comment
  }
  return files
}

/** Build the bundle into `outDir`. @param {{ root?: string, outDir?: string }} [options] */
export async function buildMcpb({ root = ROOT, outDir = join(root, 'dist') } = {}) {
  const manifest = mcpbManifest(await listServerTools(root), root)
  const entries = [
    { path: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { path: 'icon.png', data: readFileSync(join(root, json('assets/listing.json', root).logo)) },
    ...bundleSourceFiles(root).map((path) => ({ path, data: readFileSync(join(root, path)) })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const archive = zip(entries)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const name = mcpbFileName(manifest.version)
  mkdirSync(outDir, { recursive: true })
  const path = join(outDir, name)
  writeFileSync(path, archive)
  writeFileSync(`${path}.sha256`, `${sha256}  ${name}\n`)
  return { path, sha256, bytes: archive.length, files: entries.length, manifest }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  if (outIndex >= 0 ? args.length !== 2 || outIndex !== 0 : args.length !== 0) {
    process.stderr.write('Usage: node scripts/build-mcpb.mjs [--out <folder>]\n')
    process.exit(2)
  }
  const result = await buildMcpb(outIndex >= 0 ? { outDir: resolve(args[outIndex + 1]) } : {})
  const shown = relative(process.cwd(), result.path)
  process.stdout.write(`${shown.startsWith('..') ? result.path : shown}\n  ${result.files} files, ${result.bytes} bytes\n  sha256 ${result.sha256}\n`)
}
