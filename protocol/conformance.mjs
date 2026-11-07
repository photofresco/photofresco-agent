/** Language-neutral scenario runner for the Node reference transport; other SDKs run the JSON. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
const spec = JSON.parse(readFileSync(new URL('./conformance.json', import.meta.url), 'utf8'))
const get = (value, path) => path.split('.').reduce((item, key) => item?.[key], value)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export async function runConformance(transport, vars, record = () => {}) {
  const results = { vars }
  const resolve = (value) => {
    if (Array.isArray(value)) return value.map(resolve)
    if (value && typeof value === 'object') {
      if (value.$from) {
        const found = get(results, value.$from)
        assert.notEqual(found, undefined, `Unresolved ${value.$from}`)
        return found
      }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]))
    }
    return value
  }
  for (const step of spec.steps) {
    const params = resolve(step.params)
    if (step.error_code) {
      await assert.rejects(transport.call(step.method, params), (error) => {
        assert.equal(error.data?.code, step.error_code, `${step.id}: ${error.message}`)
        results[step.id] = { error: { code: error.code, data: error.data } }
        return true
      })
    } else {
      let result = await transport.call(step.method, params)
      if (step.poll) {
        const end = Date.now() + step.poll.timeout_ms
        while (JSON.stringify(get(result, step.poll.path)) !== JSON.stringify(step.poll.equals)) {
          assert.ok(Date.now() < end, `Timed out: ${step.id}`)
          await sleep(100)
          result = await transport.call(step.method, params)
        }
      }
      results[step.id] = result
      for (const [path, expected] of Object.entries(step.assert_equal ?? {})) assert.deepEqual(get(result, path), expected, `${step.id}.${path}`)
      if (step.contains_ops) for (const name of step.contains_ops) assert.ok(result.some((op) => op.name === name), `${step.id}: missing ${name}`)
      if (step.excludes_ops) for (const name of step.excludes_ops) assert.ok(!result.some((op) => op.name === name), `${step.id}: exposed ${name}`)
      if (step.assert_sha256) assert.equal(createHash('sha256').update(Buffer.from(result.data_base64, 'base64')).digest('hex'), result.sha256)
    }
    record(step.id, results[step.id])
  }
  return results
}
