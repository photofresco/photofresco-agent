// @ts-check
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Reading the agent skill (pf-agent-platform-nkwn.36) for its checks: test/skill.test.js here and
 * the live run scripts/agent-skill-e2e.mjs in the editor repository execute the same example calls.
 */

export const SKILL_DIR = fileURLToPath(new URL('../../skills/photofresco/', import.meta.url))

/** All markdown files of the skill: `{ file, text }` with `file` relative to the skill folder. */
export function skillFiles() {
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]))
  return walk(SKILL_DIR).map((path) => ({ file: relative(SKILL_DIR, path), text: readFileSync(path, 'utf8') })).sort((a, b) => a.file.localeCompare(b.file))
}

/** @param {string} file Path relative to the skill folder. */
export const skillText = (file) => readFileSync(join(SKILL_DIR, file), 'utf8')

/** Fenced blocks with their info string. @param {string} text */
export function fences(text) {
  return [...text.matchAll(/```([a-z]*)\n([\s\S]*?)```/g)].map((match) => ({ lang: match[1], body: match[2] }))
}

/** Backticked inline code spans outside fenced blocks. @param {string} text */
export function inlineCode(text) {
  return [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((match) => match[1])
}

/** The workflow document in references/workflows.md (its one ```json block). */
export function workflowDocument() {
  const blocks = fences(skillText('references/workflows.md')).filter((block) => block.lang === 'json')
  assert.equal(blocks.length, 1, 'workflows.md has exactly one JSON workflow document')
  return JSON.parse(blocks[0].body)
}

/**
 * Example tool calls: every line of an ```mcp block is `<tool> <JSON arguments>`;
 * `<the document above>` stands for the workflow document in references/workflows.md.
 * @param {string} text
 * @returns {Array<{ tool: string, args: Record<string, any>, line: string }>}
 */
export function exampleCalls(text) {
  return fences(text).filter((block) => block.lang === 'mcp').flatMap((block) => block.body.trim().split('\n').map((line) => {
    const match = line.match(/^([a-z0-9_]+) (\{.*\})$/)
    assert.ok(match, `example call is "<tool> {json}": ${line}`)
    const json = match[2].replaceAll('<the document above>', JSON.stringify(workflowDocument()))
    return { tool: match[1], args: JSON.parse(json), line }
  }))
}
