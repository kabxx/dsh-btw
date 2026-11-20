import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { PACKAGE_NAME, parseThreadId } from '../shared/wire.js'

const { version } = createRequire(import.meta.url)('../../package.json')
const SCHEMA_VERSION = 1
const releaseDirectory = /^v\d+\.\d+\.\d+$/u

async function listDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return []
  }
}

export function sessionThreadStore(persistence, parseRecord) {
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
          const envelope = JSON.parse(await readFile(file, { encoding: 'utf8', signal }))
          if (envelope.schemaVersion !== SCHEMA_VERSION) continue
          const record = parseRecord(envelope.record)
          if (record.sessionId !== sessionId) continue
          if (entry.name !== `${record.id}.json` || files.has(record.id)) throw new Error('Invalid BTW thread archive')
          files.set(record.id, file)
          records.push(record)
        }
      }
      signal.throwIfAborted()
      return {
        records,
        async put(record) {
          const id = parseThreadId(record.id)
          const file = files.get(id) ?? join(root, `v${version}`, 'threads', `${id}.json`)
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
            const envelope = { schemaVersion: SCHEMA_VERSION, record }
            await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { flag: 'wx', mode: 0o600 })
            await rename(temporary, file)
          } catch (error) {
            await unlink(temporary).catch(() => {})
            throw error
          }
          files.set(id, file)
        },
      }
    },
  }
}
