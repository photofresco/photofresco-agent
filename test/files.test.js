// @ts-check
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { FileGrants, StagedFile } from '../src/files.js'

/**
 * Path grants and staged writes against a real file system: traversal, symbolic-link
 * escapes (folder, final name, dangling), overwrite consent, size bounds, hash/length
 * mismatch and races between the check and the publish.
 */
const base = realpathSync(mkdtempSync(join(tmpdir(), 'pf-connector-files-')))
after(() => rmSync(base, { recursive: true, force: true }))

let counter = 0
function layout() {
  const dir = join(base, `case-${++counter}`)
  const inbox = join(dir, 'inbox')
  const out = join(dir, 'out')
  const outside = join(dir, 'outside')
  for (const path of [inbox, out, outside]) mkdirSync(path, { recursive: true })
  writeFileSync(join(inbox, 'photo.png'), 'PNGDATA')
  writeFileSync(join(outside, 'secret.txt'), 'SECRET')
  return { dir, inbox, out, outside }
}

/** @param {() => unknown} fn @param {string} code @param {string} [stage] */
function refuses(fn, code, stage = 'path') {
  assert.throws(fn, (error) => {
    assert.equal(/** @type {any} */ (error).code, code)
    assert.equal(/** @type {any} */ (error).stage, stage)
    return true
  })
}

/** @param {string} text */
const sha = (text) => createHash('sha256').update(text).digest('hex')

describe('folder grants', () => {
  it('canonicalizes roots and refuses missing folders, files and empty grants', () => {
    const { dir, inbox } = layout()
    const grants = new FileGrants([{ path: join(inbox, '..', 'inbox'), read: true }])
    assert.deepEqual(grants.list(), [{ path: inbox, read: true, write: false, overwrite: false }])
    assert.throws(() => grants.add({ path: join(dir, 'missing'), read: true }), { code: 'invalid_options' })
    assert.throws(() => grants.add({ path: join(inbox, 'photo.png'), read: true }), { code: 'invalid_options' })
    assert.throws(() => grants.add({ path: inbox }), { code: 'invalid_options' })
    assert.equal(grants.add({ path: inbox, overwrite: true }).write, true, 'overwrite implies write')
  })

  it('reads a granted file, resolving relative paths against cwd', () => {
    const { inbox } = layout()
    const grants = new FileGrants([{ path: inbox, read: true }], { cwd: inbox })
    const file = grants.read('photo.png')
    assert.equal(file.path, join(inbox, 'photo.png'))
    assert.equal(file.bytes.toString(), 'PNGDATA')
  })

  it('refuses traversal, ungranted folders and write-only roots for reads', () => {
    const { inbox, out, outside } = layout()
    const grants = new FileGrants([{ path: inbox, read: true }, { path: out, write: true }])
    refuses(() => grants.read(join(inbox, '..', 'outside', 'secret.txt')), 'path_not_granted')
    refuses(() => grants.read(join(outside, 'secret.txt')), 'path_not_granted')
    writeFileSync(join(out, 'written.png'), 'X')
    refuses(() => grants.read(join(out, 'written.png')), 'path_not_granted')
    // An ungranted path is refused before its existence is revealed.
    refuses(() => grants.read(join(outside, 'nope.txt')), 'path_not_granted')
    refuses(() => grants.read(join(inbox, 'nope.png')), 'read_failed')
    refuses(() => grants.read(inbox), 'not_a_file')
    refuses(() => grants.read(''), 'path_invalid')
    refuses(() => grants.read('a\0b'), 'path_invalid')
  })

  it('refuses symbolic links that leave the granted folder', () => {
    const { inbox, outside } = layout()
    symlinkSync(join(outside, 'secret.txt'), join(inbox, 'link.txt'))
    symlinkSync(outside, join(inbox, 'linked-dir'))
    const grants = new FileGrants([{ path: inbox, read: true }])
    refuses(() => grants.read(join(inbox, 'link.txt')), 'path_escape')
    refuses(() => grants.read(join(inbox, 'linked-dir', 'secret.txt')), 'path_escape')
  })

  it('bounds import size', () => {
    const { inbox } = layout()
    const grants = new FileGrants([{ path: inbox, read: true }])
    refuses(() => grants.read(join(inbox, 'photo.png'), { maxBytes: 3 }), 'file_too_large')
  })
})

describe('write targets', () => {
  it('creates missing folders inside the root and reports the canonical target', () => {
    const { out } = layout()
    const grants = new FileGrants([{ path: out, write: true }])
    const target = grants.prepareWrite(join(out, 'a', 'b', 'result.png'))
    assert.equal(target.path, join(out, 'a', 'b', 'result.png'))
    assert.equal(target.exists, false)
    assert.ok(lstatSync(join(out, 'a', 'b')).isDirectory())
  })

  it('refuses traversal and read-only roots', () => {
    const { inbox, out, outside } = layout()
    const grants = new FileGrants([{ path: inbox, read: true }, { path: out, write: true }])
    refuses(() => grants.prepareWrite(join(out, '..', 'outside', 'x.png')), 'path_not_granted')
    refuses(() => grants.prepareWrite(join(inbox, 'x.png')), 'path_not_granted')
    refuses(() => grants.prepareWrite(out), 'path_not_granted')
    refuses(() => grants.prepareWrite(join(outside, 'x.png')), 'path_not_granted')
    assert.equal(existsSync(join(outside, 'x.png')), false)
  })

  it('refuses links in the folder chain, at the final name and dangling links', () => {
    const { out, outside } = layout()
    symlinkSync(outside, join(out, 'escape'))
    writeFileSync(join(out, 'inside.png'), 'IN')
    symlinkSync(join(out, 'inside.png'), join(out, 'alias.png'))
    symlinkSync(join(outside, 'missing-dir'), join(out, 'dangling'))
    const grants = new FileGrants([{ path: out, write: true, overwrite: true }])
    refuses(() => grants.prepareWrite(join(out, 'escape', 'x.png')), 'path_escape')
    refuses(() => grants.prepareWrite(join(out, 'escape', 'new', 'x.png')), 'path_escape')
    refuses(() => grants.prepareWrite(join(out, 'alias.png'), { overwrite: true }), 'path_escape')
    refuses(() => grants.prepareWrite(join(out, 'dangling', 'x.png')), 'path_escape')
    assert.deepEqual(readdirSync(outside).sort(), ['secret.txt'])
  })

  it('needs both the root grant and the request to overwrite', () => {
    const { out } = layout()
    writeFileSync(join(out, 'keep.png'), 'OLD')
    mkdirSync(join(out, 'folder.png'))
    const noOverwrite = new FileGrants([{ path: out, write: true }])
    refuses(() => noOverwrite.prepareWrite(join(out, 'keep.png')), 'file_exists')
    refuses(() => noOverwrite.prepareWrite(join(out, 'keep.png'), { overwrite: true }), 'file_exists')
    const overwrite = new FileGrants([{ path: out, overwrite: true }])
    refuses(() => overwrite.prepareWrite(join(out, 'keep.png')), 'file_exists')
    assert.equal(overwrite.prepareWrite(join(out, 'keep.png'), { overwrite: true }).exists, true)
    refuses(() => overwrite.prepareWrite(join(out, 'folder.png'), { overwrite: true }), 'not_a_file')
  })
})

describe('staged writes', () => {
  it('publishes only after the length and SHA-256 match, leaving no temporary file', () => {
    const { out } = layout()
    const grants = new FileGrants([{ path: out, write: true }])
    const staged = new StagedFile(grants.prepareWrite(join(out, 'result.png')))
    staged.write(Buffer.from('HELLO '))
    assert.equal(existsSync(join(out, 'result.png')), false, 'nothing visible before commit')
    staged.write(Buffer.from('WORLD'))
    const written = staged.commit({ sha256: sha('HELLO WORLD'), bytes: 11 })
    assert.deepEqual(written, { path: join(out, 'result.png'), bytes: 11, sha256: sha('HELLO WORLD'), replaced: false })
    assert.equal(readFileSync(join(out, 'result.png'), 'utf8'), 'HELLO WORLD')
    assert.deepEqual(readdirSync(out), ['result.png'])
  })

  it('writes nothing when the bytes do not match the artifact digest or length', () => {
    const { out } = layout()
    writeFileSync(join(out, 'existing.png'), 'ORIGINAL')
    const grants = new FileGrants([{ path: out, overwrite: true }])
    const mismatch = new StagedFile(grants.prepareWrite(join(out, 'existing.png'), { overwrite: true }))
    mismatch.write(Buffer.from('TAMPERED'))
    assert.throws(() => mismatch.commit({ sha256: sha('EXPECTED'), bytes: 8 }), { code: 'artifact_hash_mismatch', stage: 'retrieval' })
    const short = new StagedFile(grants.prepareWrite(join(out, 'new.png')))
    short.write(Buffer.from('ABC'))
    assert.throws(() => short.commit({ sha256: sha('ABCD'), bytes: 4 }), { code: 'artifact_incomplete', stage: 'retrieval' })
    assert.equal(readFileSync(join(out, 'existing.png'), 'utf8'), 'ORIGINAL')
    assert.deepEqual(readdirSync(out), ['existing.png'])
  })

  it('replaces an existing file atomically with overwrite consent', () => {
    const { out } = layout()
    writeFileSync(join(out, 'existing.png'), 'ORIGINAL')
    const grants = new FileGrants([{ path: out, overwrite: true }])
    const staged = new StagedFile(grants.prepareWrite(join(out, 'existing.png'), { overwrite: true }))
    staged.write(Buffer.from('NEW'))
    assert.equal(readFileSync(join(out, 'existing.png'), 'utf8'), 'ORIGINAL', 'old content until commit')
    assert.equal(staged.commit({ sha256: sha('NEW'), bytes: 3 }).replaced, true)
    assert.equal(readFileSync(join(out, 'existing.png'), 'utf8'), 'NEW')
    assert.deepEqual(readdirSync(out), ['existing.png'])
  })

  it('never clobbers a file or follows a link that appeared during the transfer', () => {
    const { out, outside } = layout()
    const grants = new FileGrants([{ path: out, write: true }])
    const racedFile = new StagedFile(grants.prepareWrite(join(out, 'raced.png')))
    racedFile.write(Buffer.from('MINE'))
    writeFileSync(join(out, 'raced.png'), 'THEIRS')
    assert.throws(() => racedFile.commit({ sha256: sha('MINE'), bytes: 4 }), { code: 'file_exists', stage: 'write' })
    assert.equal(readFileSync(join(out, 'raced.png'), 'utf8'), 'THEIRS')

    const racedLink = new StagedFile(grants.prepareWrite(join(out, 'link.png')))
    racedLink.write(Buffer.from('MINE'))
    symlinkSync(join(outside, 'secret.txt'), join(out, 'link.png'))
    assert.throws(() => racedLink.commit({ sha256: sha('MINE'), bytes: 4 }), { code: 'path_escape', stage: 'write' })
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'SECRET')
    assert.deepEqual(readdirSync(out).sort(), ['link.png', 'raced.png'])
  })

  it('abort removes the temporary file and leaves the target alone', () => {
    const { out } = layout()
    const grants = new FileGrants([{ path: out, write: true }])
    const staged = new StagedFile(grants.prepareWrite(join(out, 'aborted.png')))
    staged.write(Buffer.from('PARTIAL'))
    staged.abort()
    assert.deepEqual(readdirSync(out), [])
  })
})
