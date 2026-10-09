// @ts-check
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ConnectorError } from './errors.js'

/**
 * Local file access under explicit folder grants (pf-agent-platform-nkwn.14).
 *
 * - Roots are granted by the person running the connector (adapter configuration or the
 *   MCP client's roots), never by the model. Each root is canonicalized once
 *   (`realpath`) and grants read, write and/or overwrite.
 * - A path is allowed only when its canonical location is inside a root with that access.
 *   `..` segments are resolved before the check; a symbolic link anywhere in the path that
 *   leads outside the root is refused (`path_escape`); writing through a symbolic link at
 *   the final name is refused even when it points inside.
 * - Reads open the canonical file without following links and confirm it is the same
 *   file that was checked; reads are bounded by size.
 * - Writes are staged in a hidden temporary file next to the target and become visible
 *   only through one atomic rename (overwrite) or hard link (no overwrite: fails if the
 *   name appeared meanwhile), after the complete content was received and its SHA-256
 *   matched. A failed or mismatched transfer never touches the target.
 * - Overwriting an existing file needs both the root's `overwrite` grant and the
 *   request's explicit `overwrite: true`.
 */

export const FILE_LIMITS = Object.freeze({
  /** Largest file imported (the editor's doc.open transport cap). */
  maxImportBytes: 32 * 1024 * 1024,
  /** Largest file written (the editor's artifact cap). */
  maxWriteBytes: 256 * 1024 * 1024,
  maxPathLength: 4096,
})

const NOFOLLOW = constants.O_NOFOLLOW ?? 0

/**
 * @typedef {object} RootGrant
 * @property {string} path Existing folder.
 * @property {boolean} [read] Import files from it.
 * @property {boolean} [write] Create new files in it (and in new subfolders).
 * @property {boolean} [overwrite] Also replace existing files (requires write).
 *
 * @typedef {object} GrantedRoot
 * @property {string} path Canonical folder path.
 * @property {boolean} read
 * @property {boolean} write
 * @property {boolean} overwrite
 *
 * @typedef {GrantedRoot & { lexical: string }} Root
 */

/** @param {string} root @param {string} candidate */
export function isInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** @param {string} root @param {string} candidate */
function isWithin(root, candidate) {
  return root === candidate || isInside(root, candidate)
}

/** @param {string} message @param {string} [code] */
function pathError(message, code = 'path_invalid') {
  return new ConnectorError(code, message, { stage: 'path' })
}

/** @param {unknown} value @returns {string} */
function checkInput(value) {
  if (typeof value !== 'string' || !value.trim()) throw pathError('path must be a non-empty string')
  if (value.length > FILE_LIMITS.maxPathLength) throw pathError(`path must be at most ${FILE_LIMITS.maxPathLength} characters`)
  if (value.includes('\0')) throw pathError('path must not contain NUL characters')
  return value
}

export class FileGrants {
  /**
   * @param {RootGrant[]} [roots]
   * @param {{ cwd?: string }} [options] Relative paths resolve against `cwd` (default: process.cwd()).
   */
  constructor(roots = [], options = {}) {
    this.cwd = options.cwd ?? process.cwd()
    /** @type {Root[]} */
    this.roots = []
    for (const root of roots) this.add(root)
  }

  /**
   * Grant a folder. Trusted callers only (the person's configuration), never model input.
   * @param {RootGrant} grant
   * @returns {GrantedRoot}
   */
  add(grant) {
    if (!grant || typeof grant !== 'object') throw new ConnectorError('invalid_options', 'A root grant is { path, read?, write?, overwrite? }')
    const lexical = resolve(this.cwd, checkInput(grant.path))
    /** @type {string} */
    let canonical
    try {
      canonical = realpathSync.native(lexical)
    } catch {
      throw new ConnectorError('invalid_options', `Granted folder does not exist: ${lexical}`)
    }
    if (!statSync(canonical).isDirectory()) throw new ConnectorError('invalid_options', `Granted path is not a folder: ${lexical}`)
    const read = grant.read === true
    const write = grant.write === true || grant.overwrite === true
    const overwrite = grant.overwrite === true
    if (!read && !write) throw new ConnectorError('invalid_options', `Grant read and/or write for ${lexical}`)
    const existing = this.roots.find((root) => root.path === canonical)
    if (existing) {
      existing.read ||= read
      existing.write ||= write
      existing.overwrite ||= overwrite
      return publicRoot(existing)
    }
    const root = { path: canonical, lexical, read, write, overwrite }
    this.roots.push(root)
    return publicRoot(root)
  }

  /** @returns {GrantedRoot[]} */
  list() {
    return this.roots.map(publicRoot)
  }

  /**
   * @param {string} absolute
   * @param {'read' | 'write'} access
   * @param {string} canonical Canonical location of the path (or its deepest existing folder).
   */
  authorize(absolute, access, canonical) {
    const granted = this.roots.filter((root) => root[access])
    const root = granted.find((candidate) => isWithin(candidate.path, canonical))
    if (root) return root
    if (granted.some((candidate) => isInside(candidate.lexical, absolute) || isInside(candidate.path, absolute))) {
      throw pathError(`${absolute} resolves outside its granted folder through a symbolic link`, 'path_escape')
    }
    const kinds = access === 'read' ? 'read' : 'write'
    throw pathError(granted.length
      ? `${absolute} is not inside a folder granted for ${kinds} (${granted.map((candidate) => candidate.path).join(', ')})`
      : `No folder is granted for ${kinds}; the person running the connector must grant one`, 'path_not_granted')
  }

  /**
   * Read a granted file (bounded, not through links, the same file that was checked).
   * @param {unknown} input
   * @param {{ maxBytes?: number }} [options]
   * @returns {{ path: string, bytes: Buffer, root: GrantedRoot }}
   */
  read(input, options = {}) {
    const absolute = resolve(this.cwd, checkInput(input))
    const maxBytes = options.maxBytes ?? FILE_LIMITS.maxImportBytes
    /** @type {string} */
    let canonical
    try {
      canonical = realpathSync.native(absolute)
    } catch {
      // Authorize the folder first so an ungranted path never reveals whether it exists.
      this.authorize(absolute, 'read', canonicalAncestor(absolute))
      throw pathError(`${absolute} does not exist`, 'read_failed')
    }
    const root = this.authorize(absolute, 'read', canonical)
    if (canonical === root.path) throw pathError(`${absolute} is a folder, not a file`, 'not_a_file')
    const checked = statSync(canonical)
    if (!checked.isFile()) throw pathError(`${absolute} is not a regular file`, 'not_a_file')
    if (checked.size > maxBytes) throw pathError(`${absolute} is ${checked.size} bytes; at most ${maxBytes} can be imported`, 'file_too_large')
    /** @type {number} */
    let fd
    try {
      fd = openSync(canonical, constants.O_RDONLY | NOFOLLOW)
    } catch (error) {
      throw new ConnectorError('read_failed', `${absolute} could not be opened: ${/** @type {Error} */ (error).message}`, { stage: 'path' })
    }
    try {
      const opened = fstatSync(fd)
      if (opened.ino !== checked.ino || opened.dev !== checked.dev || !opened.isFile()) {
        throw pathError(`${absolute} changed while it was being opened`, 'path_escape')
      }
      const bytes = Buffer.allocUnsafe(Math.min(opened.size, maxBytes) + 1)
      let length = 0
      for (;;) {
        const read = readSync(fd, bytes, length, bytes.length - length, null)
        if (read === 0) break
        length += read
        // One byte more than stat reported means the file changed while it was read.
        if (length === bytes.length) throw pathError(`${absolute} changed while it was being read`, length > maxBytes ? 'file_too_large' : 'read_failed')
      }
      return { path: canonical, bytes: bytes.subarray(0, length), root: publicRoot(root) }
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Check a write target and create missing folders inside its root. Nothing is written.
   * @param {unknown} input
   * @param {{ overwrite?: boolean }} [options]
   * @returns {WriteTarget}
   */
  prepareWrite(input, options = {}) {
    const absolute = resolve(this.cwd, checkInput(input))
    const name = basename(absolute)
    if (!name || name === '.' || name === '..') throw pathError(`${absolute} does not name a file`)
    const parent = dirname(absolute)
    const missing = []
    let existing = parent
    for (;;) {
      try {
        lstatSync(existing)
        break
      } catch {
        const up = dirname(existing)
        if (up === existing) throw pathError(`${absolute} has no existing folder`)
        missing.unshift(basename(existing))
        existing = up
      }
    }
    /** @type {string} */
    let canonicalExisting
    try {
      canonicalExisting = realpathSync.native(existing)
    } catch {
      throw pathError(`${existing} cannot be resolved (broken symbolic link?)`, 'path_escape')
    }
    const root = this.authorize(absolute, 'write', canonicalExisting)
    if (!statSync(canonicalExisting).isDirectory()) throw pathError(`${existing} is not a folder`, 'not_a_file')
    let dir = canonicalExisting
    for (const segment of missing) {
      dir = join(dir, segment)
      try {
        mkdirSync(dir)
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') {
          throw new ConnectorError('write_failed', `Could not create ${dir}: ${/** @type {Error} */ (error).message}`, { stage: 'write' })
        }
      }
      const created = lstatSync(dir)
      if (created.isSymbolicLink()) throw pathError(`${dir} is a symbolic link`, 'path_escape')
      if (!created.isDirectory()) throw pathError(`${dir} is not a folder`, 'not_a_file')
    }
    const canonicalDir = realpathSync.native(dir)
    if (!isWithin(root.path, canonicalDir)) throw pathError(`${absolute} resolves outside its granted folder through a symbolic link`, 'path_escape')
    const target = join(canonicalDir, name)
    const exists = targetState(target, absolute, options.overwrite === true, root)
    return { path: target, dir: canonicalDir, name, root: publicRoot(root), exists, overwrite: options.overwrite === true }
  }
}

/**
 * @typedef {object} WriteTarget
 * @property {string} path Canonical folder + file name.
 * @property {string} dir
 * @property {string} name
 * @property {GrantedRoot} root
 * @property {boolean} exists
 * @property {boolean} overwrite The request asked to overwrite.
 */

/** @param {Root} root @returns {GrantedRoot} */
function publicRoot(root) {
  return { path: root.path, read: root.read, write: root.write, overwrite: root.overwrite }
}

/** @param {string} absolute Deepest existing ancestor's canonical path (for authorization of missing files). */
function canonicalAncestor(absolute) {
  let current = absolute
  for (;;) {
    try {
      return realpathSync.native(current)
    } catch {
      const up = dirname(current)
      if (up === current) return current
      current = up
    }
  }
}

/**
 * Whether the target exists, refusing links, non-files and overwrites without consent.
 * @param {string} target @param {string} shown @param {boolean} requested @param {GrantedRoot} root
 */
function targetState(target, shown, requested, root) {
  /** @type {import('node:fs').Stats} */
  let stat
  try {
    stat = lstatSync(target)
  } catch {
    return false
  }
  if (stat.isSymbolicLink()) throw pathError(`${shown} is a symbolic link; the connector does not write through links`, 'path_escape')
  if (!stat.isFile()) throw pathError(`${shown} exists and is not a regular file`, 'not_a_file')
  if (!requested) throw pathError(`${shown} exists; pass overwrite: true to replace it`, 'file_exists')
  if (!root.overwrite) throw pathError(`${shown} exists and its folder is granted without overwrite`, 'file_exists')
  return true
}

/**
 * A hidden temporary file next to the target. Bytes are hashed as they are written; the
 * target appears only on commit() after the length and SHA-256 match.
 */
export class StagedFile {
  /** @param {WriteTarget} target */
  constructor(target) {
    this.target = target
    this.temp = join(target.dir, `.${target.name}.${randomBytes(6).toString('hex')}.pf-partial`)
    /** @type {number | null} */
    this.fd = null
    try {
      this.fd = openSync(this.temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o644)
    } catch (error) {
      throw new ConnectorError('write_failed', `Could not create a temporary file in ${target.dir}: ${/** @type {Error} */ (error).message}`, { stage: 'write' })
    }
    this.hash = createHash('sha256')
    this.bytes = 0
    this.done = false
  }

  /** @param {Uint8Array} chunk */
  write(chunk) {
    try {
      let offset = 0
      while (offset < chunk.length) offset += writeSync(/** @type {number} */ (this.fd), chunk, offset, chunk.length - offset)
    } catch (error) {
      this.abort()
      throw new ConnectorError('write_failed', `Writing ${this.target.path} failed: ${/** @type {Error} */ (error).message}`, { stage: 'write' })
    }
    this.hash.update(chunk)
    this.bytes += chunk.length
  }

  /**
   * Verify and publish. Throws (and removes the temporary file) on any mismatch.
   * @param {{ sha256: string, bytes: number }} expected
   * @returns {{ path: string, bytes: number, sha256: string, replaced: boolean }}
   */
  commit(expected) {
    const digest = this.hash.digest('hex')
    if (this.bytes !== expected.bytes) {
      this.abort()
      throw new ConnectorError('artifact_incomplete', `Received ${this.bytes} of ${expected.bytes} bytes; nothing was written`, { stage: 'retrieval' })
    }
    if (digest !== expected.sha256) {
      this.abort()
      throw new ConnectorError('artifact_hash_mismatch', `The retrieved bytes hash to ${digest}, not the artifact's ${expected.sha256}; nothing was written`, { stage: 'retrieval' })
    }
    try {
      fsyncSync(/** @type {number} */ (this.fd))
      closeSync(/** @type {number} */ (this.fd))
      this.fd = null
      // Re-check the name right before publishing: it may have become a link or a file.
      const replaced = targetState(this.target.path, this.target.path, this.target.overwrite, this.target.root)
      if (replaced) renameSync(this.temp, this.target.path)
      else publishNew(this.temp, this.target.path)
      this.done = true
      syncDir(this.target.dir)
      return { path: this.target.path, bytes: this.bytes, sha256: digest, replaced }
    } catch (error) {
      this.abort()
      if (error instanceof ConnectorError) throw new ConnectorError(error.code, error.message, { stage: 'write' })
      throw new ConnectorError('write_failed', `Writing ${this.target.path} failed: ${/** @type {Error} */ (error).message}`, { stage: 'write' })
    }
  }

  /** Remove the temporary file; the target is untouched. */
  abort() {
    if (this.done) return
    this.done = true
    if (this.fd !== null && this.fd !== undefined) {
      try {
        closeSync(this.fd)
      } catch {
        // Already closed.
      }
      this.fd = null
    }
    try {
      unlinkSync(this.temp)
    } catch {
      // Already gone.
    }
  }
}

/** Publish without replacing: a hard link fails if the name exists. @param {string} temp @param {string} target */
function publishNew(temp, target) {
  try {
    linkSync(temp, target)
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    if (code === 'EEXIST') throw pathError(`${target} appeared while the export was running; nothing was replaced`, 'file_exists')
    // File systems without hard links (FAT, some network shares): check, then rename.
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw error
    try {
      lstatSync(target)
      throw pathError(`${target} appeared while the export was running; nothing was replaced`, 'file_exists')
    } catch (missing) {
      if (missing instanceof ConnectorError) throw missing
    }
    renameSync(temp, target)
    return
  }
  unlinkSync(temp)
}

/** Persist the rename in the folder (POSIX); best effort elsewhere. @param {string} dir */
function syncDir(dir) {
  try {
    const fd = openSync(dir, constants.O_RDONLY)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Windows cannot open folders for fsync.
  }
}
