// @ts-check
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Resolve the generated manifest to the SAME namespace shards MCP ships; no second inventory. */
export function loadProtocolCatalog() {
  const base = new URL('../../protocol/op-catalog.json', import.meta.url)
  const manifest = JSON.parse(readFileSync(base, 'utf8'))
  /** @type {import('../mcp/tools.js').Operation[]} */
  const operations = manifest.shards.flatMap((/** @type {{path: string, sha256: string}} */ shard) => {
    if (!/^\.\.\/src\/mcp\/catalog\/[a-z_]+\.json$/.test(shard.path)) throw new Error('Invalid catalog shard path')
    const bytes = readFileSync(new URL(shard.path, base))
    if (createHash('sha256').update(bytes).digest('hex') !== shard.sha256) throw new Error(`Catalog drift: ${shard.path}`)
    return JSON.parse(bytes.toString('utf8')).operations
  }).sort((/** @type {import('../mcp/tools.js').Operation} */ a, /** @type {import('../mcp/tools.js').Operation} */ b) => a.name.localeCompare(b.name))
  const hash = createHash('sha256').update(JSON.stringify(operations)).digest('hex')
  if (hash !== manifest.sha256 || operations.length !== manifest.operation_count) throw new Error('Catalog drift: regenerate the protocol manifest')
  return { schema_version: manifest.schema_version, operations }
}
