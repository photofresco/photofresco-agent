// @ts-check
/** Small JSON Schema admission for the protocol's owned vocabulary. Operation params are
 * admitted by the editor registry, never by a second SDK validator. */
/** @param {any} value @param {Record<string, any>} schema @param {any} root @param {string} [path] @returns {string | null} */
export function validate(value, schema, root, path = 'params') {
  if (schema.$ref) {
    const target = schema.$ref.split('/').slice(1).reduce((/** @type {any} */ node, /** @type {string} */ key) => node?.[key], root)
    if (!target) return `Unresolved schema ${schema.$ref}`
    return validate(value, target, root, path)
  }
  if (schema.enum && !schema.enum.some((/** @type {any} */ item) => JSON.stringify(item) === JSON.stringify(value))) return `${path}: invalid value`
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : []
  if (types.length && !types.some((/** @type {string} */ type) => {
    if (type === 'null') return value === null
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
    if (type === 'array') return Array.isArray(value)
    if (type === 'integer') return Number.isSafeInteger(value)
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
    return typeof value === type
  })) return `${path}: expected ${types.join(' or ')}`
  if (typeof value === 'string') {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return `${path}: string length outside bounds`
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path}: invalid format`
  }
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return `${path}: number outside bounds`
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return `${path}: array length outside bounds`
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return `${path}: duplicate values`
    if (schema.items) for (let i = 0; i < value.length; i++) {
      const error = validate(value[i], schema.items, root, `${path}[${i}]`)
      if (error) return error
    }
  } else if (value !== null && typeof value === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return `${path}.${key}: required`
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) return `${path}: forbidden key`
      const child = schema.properties?.[key]
      if (!child && schema.additionalProperties === false) return `${path}.${key}: unknown field`
      if (child) {
        const error = validate(item, child, root, `${path}.${key}`)
        if (error) return error
      }
    }
  }
  return null
}
