import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { PACKAGE_NAME, parseThreadId } from '../shared/wire.js'

const { version } = createRequire(import.meta.url)('../../package.json')
const INLINE_SCHEMA_VERSION = 1
const SCHEMA_VERSION = 2
const releaseDirectory = /^v\d+\.\d+\.\d+$/u

async function listDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return []
  }
}

async function replaceArchiveFile(sessionDirectory, file, value, ownerSignal) {
  ownerSignal.throwIfAborted()
  let directory = sessionDirectory
  for (const part of relative(sessionDirectory, dirname(file)).split(sep)) {
    directory = join(directory, part)
    // Start below the session root so a removed session cannot be recreated here.
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
    // Agent scope teardown revokes writes before the main session lease closes.
    // Keep the ownership check and final replacement in the same JS turn.
    ownerSignal.throwIfAborted()
    renameSync(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

function snapshotFileFor(file) {
  return join(dirname(dirname(file)), 'snapshots', basename(file))
}

async function readSnapshot(file, signal, schema, onMalformedRecord) {
  const contents = await readFile(snapshotFileFor(file), { encoding: 'utf8', signal }).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  if (contents === undefined) {
    onMalformedRecord?.(file, 'missing thread snapshot')
    return
  }
  let snapshot
  try {
    snapshot = JSON.parse(contents)
  } catch {
    onMalformedRecord?.(file, 'invalid thread snapshot JSON')
    return
  }
  const parsed = schema.safeParse(snapshot)
  if (!parsed.success) {
    onMalformedRecord?.(file, 'invalid thread snapshot')
    return
  }
  return parsed.data
}

export function sessionThreadStore(persistence, schemas, onMalformedRecord, onSnapshotCleanupError) {
  return {
    async open(sessionId, signal) {
      const snapshot = await persistence.stat(sessionId, { signal })
      signal.throwIfAborted()
      const location = snapshot?.location
      if (location?.kind !== 'jsonl' || !location.path || !isAbsolute(location.path)) return undefined

      const sessionDirectory = dirname(location.path)
      const directoryInfo = await stat(sessionDirectory).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
      if (!directoryInfo?.isDirectory()) return undefined
      const root = join(sessionDirectory, 'plugins', PACKAGE_NAME)
      const records = []
      const files = new Map()
      for (const release of await listDirectory(root)) {
        if (!release.isDirectory() || !releaseDirectory.test(release.name)) continue
        const directory = join(root, release.name, 'threads')
        for (const entry of await listDirectory(directory)) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue
          const file = join(directory, entry.name)
          let contents
          try {
            contents = await readFile(file, { encoding: 'utf8', signal })
          } catch (error) {
            if (error?.code !== 'EACCES' && error?.code !== 'EPERM') throw error
            signal.throwIfAborted()
            onMalformedRecord?.(file, `cannot read thread record (${error.code})`)
            continue
          }
          let envelope
          try {
            envelope = JSON.parse(contents)
          } catch {
            onMalformedRecord?.(file, 'invalid JSON')
            continue
          }
          if (typeof envelope?.schemaVersion !== 'number') {
            onMalformedRecord?.(file, 'invalid archive envelope')
            continue
          }
          const { schemaVersion } = envelope
          if (schemaVersion !== INLINE_SCHEMA_VERSION && schemaVersion !== SCHEMA_VERSION) continue
          const hasSnapshot = schemaVersion === SCHEMA_VERSION
          let record
          try {
            record = (hasSnapshot ? schemas.record : schemas.inline).parse(envelope.record)
          } catch {
            onMalformedRecord?.(file, 'invalid thread record')
            continue
          }
          if (record.sessionId !== sessionId) continue
          if (entry.name !== `${record.id}.json` || files.has(record.id)) {
            onMalformedRecord?.(file, 'invalid or duplicate thread filename')
            continue
          }
          files.set(record.id, { file, hasSnapshot })
          records.push(record)
        }
      }
      signal.throwIfAborted()
      return {
        records,
        async loadSnapshot(id) {
          signal.throwIfAborted()
          const entry = files.get(parseThreadId(id))
          if (!entry?.hasSnapshot) return
          const loading = entry.loading ??= readSnapshot(entry.file, signal, schemas.snapshot, onMalformedRecord)
          let snapshot
          try {
            snapshot = await loading
            signal.throwIfAborted()
            return snapshot
          } finally {
            // Keep successful reads for this owner, and allow repaired files to be read again.
            if (snapshot === undefined && entry.loading === loading) delete entry.loading
          }
        },
        async put({ snapshot, ...record }, ownerSignal = signal) {
          ownerSignal.throwIfAborted()
          const id = parseThreadId(record.id)
          const existing = files.get(id)
          const file = existing?.file ?? join(root, `v${version}`, 'threads', `${id}.json`)
          const snapshotFile = snapshotFileFor(file)
          if (!existing?.hasSnapshot) {
            // Publish the frozen prefix first so either archive format stays readable.
            await replaceArchiveFile(sessionDirectory, snapshotFile, schemas.snapshot.parse(snapshot), ownerSignal)
          }
          try {
            await replaceArchiveFile(sessionDirectory, file, { schemaVersion: SCHEMA_VERSION, record }, ownerSignal)
          } catch (error) {
            // A failed first admission has no thread referencing this snapshot.
            // Keep the ownership check and cleanup in the same JS turn.
            if (!existing && !ownerSignal.aborted) {
              try {
                unlinkSync(snapshotFile)
              } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') onSnapshotCleanupError?.(snapshotFile, cleanupError)
              }
            }
            throw error
          }
          if (!existing?.hasSnapshot) files.set(id, { file, hasSnapshot: true })
        },
      }
    },
  }
}
