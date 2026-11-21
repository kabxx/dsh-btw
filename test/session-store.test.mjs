import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs, { mkdir, mkdtempDisposable, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { archiveSchemas } from '../src/host/index.js'
import { sessionThreadStore } from '../src/host/session-store.js'
import { PACKAGE_NAME } from '../src/shared/wire.js'

const sessionId = 'session-archive-fixture'
const healthyId = 'btw-12345678-1234-1234-1234-123456789012'
const newId = 'btw-12345678-1234-1234-1234-123456789013'

function makeRecord(id) {
  return {
    id, sessionId, question: 'side question', createdAt: 1, updatedAt: 2, version: 1,
    route: { provider: 'fixture-provider', model: 'fixture-model' },
    snapshot: { mode: 'native', anchor: null, messages: [] },
    turns: [{ question: 'side question', reply: 'answer', status: 'completed', createdAt: 1, finishedAt: 2 }],
  }
}

function makeStore(path, onMalformedRecord) {
  const persistence = {
    async stat(id) {
      assert.equal(id, sessionId)
      return { location: { kind: 'jsonl', path } }
    },
  }
  return sessionThreadStore(persistence, archiveSchemas, onMalformedRecord)
}

test('a corrupt thread does not prevent reading and creating healthy side questions', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'dsh-btw-corrupt-archive-'))
  const path = join(scratch.path, 'session.jsonl')
  const directory = join(scratch.path, 'plugins', PACKAGE_NAME, 'v0.0.9', 'threads')
  await mkdir(directory, { recursive: true })
  await writeFile(path, 'main transcript fixture\n')
  const healthy = makeRecord(healthyId)
  const healthyFile = join(directory, `${healthyId}.json`)
  const healthyContents = JSON.stringify({ schemaVersion: 1, record: healthy })
  await writeFile(healthyFile, healthyContents)
  const malformed = [
    ['truncated.json', '{"schemaVersion":1,"record":', 'invalid JSON'],
    ['schema-mismatch.json', '{"schemaVersion":1,"record":{}}', 'invalid thread record'],
    ['null.json', 'null', 'invalid archive envelope'],
  ]
  for (const [name, contents] of malformed) await writeFile(join(directory, name), contents)
  const warnings = new Map()
  const store = makeStore(path, (file, reason) => warnings.set(file, reason))
  const { signal } = new AbortController()
  const opened = await store.open(sessionId, signal)
  assert.deepEqual(opened.records, [healthy])
  assert.deepEqual(warnings, new Map(malformed.map(([name, , reason]) => [join(directory, name), reason])))
  const added = makeRecord(newId)
  await opened.put(added)
  const reopened = await store.open(sessionId, signal)
  const { snapshot, ...thread } = added
  assert.deepEqual(new Map(reopened.records.map(record => [record.id, record])), new Map([[healthy.id, healthy], [added.id, thread]]))
  assert.deepEqual(await reopened.loadSnapshot(added.id), snapshot)
  for (const [name, contents] of malformed) assert.equal(await readFile(join(directory, name), 'utf8'), contents)
  assert.equal(await readFile(healthyFile, 'utf8'), healthyContents)
  assert.equal(await readFile(path, 'utf8'), 'main transcript fixture\n')
})

test('an unreadable thread does not prevent reading and creating healthy side questions', async t => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'dsh-btw-unreadable-archive-'))
  const path = join(scratch.path, 'session.jsonl')
  const directory = join(scratch.path, 'plugins', PACKAGE_NAME, 'v0.0.9', 'threads')
  await mkdir(directory, { recursive: true })
  await writeFile(path, 'main transcript fixture\n')
  const healthy = makeRecord(healthyId)
  await writeFile(join(directory, `${healthyId}.json`), JSON.stringify({ schemaVersion: 1, record: healthy }))
  const deniedIds = ['btw-12345678-1234-1234-1234-123456789014', 'btw-12345678-1234-1234-1234-123456789015']
  const deniedFiles = new Map(deniedIds.map((id, index) => [join(directory, `${id}.json`), index === 0 ? 'EACCES' : 'EPERM']))
  for (const id of deniedIds) {
    await writeFile(join(directory, `${id}.json`), JSON.stringify({ schemaVersion: 1, record: makeRecord(id) }))
  }

  const warnings = new Map()
  const store = makeStore(path, (file, reason) => warnings.set(file, reason))
  const { signal } = new AbortController()
  const originalReadFile = fs.readFile
  const readMock = t.mock.method(fs, 'readFile', async (file, options) => {
    const code = deniedFiles.get(file)
    if (code) throw Object.assign(new Error(`read failed: ${code}`), { code })
    return originalReadFile(file, options)
  })
  syncBuiltinESMExports()
  try {
    const opened = await store.open(sessionId, signal)
    assert.deepEqual(opened.records, [healthy])
    assert.deepEqual(warnings, new Map([...deniedFiles].map(([file, code]) => [file, `cannot read thread record (${code})`])))
    const added = makeRecord(newId)
    await opened.put(added)
    const reopened = await store.open(sessionId, signal)
    const { snapshot, ...thread } = added
    assert.deepEqual(new Map(reopened.records.map(record => [record.id, record])), new Map([[healthy.id, healthy], [added.id, thread]]))
    assert.deepEqual(await reopened.loadSnapshot(added.id), snapshot)

    deniedFiles.set(deniedFiles.keys().next().value, 'EIO')
    await assert.rejects(store.open(sessionId, signal), { code: 'EIO' })
  } finally {
    readMock.mock.restore()
    syncBuiltinESMExports()
  }
  for (const id of deniedIds) {
    const contents = await readFile(join(directory, `${id}.json`), 'utf8')
    assert.deepEqual(JSON.parse(contents), { schemaVersion: 1, record: makeRecord(id) })
  }
  assert.equal(await readFile(path, 'utf8'), 'main transcript fixture\n')
})

test('archive reads still report filesystem errors and respect aborts', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'dsh-btw-invalid-archive-path-'))
  const path = join(scratch.path, 'session.jsonl')
  const directory = join(scratch.path, 'plugins', PACKAGE_NAME, 'v0.0.9')
  await mkdir(directory, { recursive: true })
  await writeFile(path, 'main transcript fixture\n')
  await writeFile(join(directory, 'threads'), 'file in place of archive directory')
  const store = makeStore(path, () => assert.fail('Filesystem errors are separate from malformed records'))
  await assert.rejects(store.open(sessionId, new AbortController().signal), { code: 'ENOTDIR' })
  await assert.rejects(store.open(sessionId, AbortSignal.abort()), { name: 'AbortError' })
})

test('progress writes keep a large frozen snapshot in one immutable file', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'dsh-btw-split-archive-'))
  const path = join(scratch.path, 'session.jsonl')
  await writeFile(path, 'main transcript fixture\n')
  const { version } = createRequire(import.meta.url)('../package.json')
  const directory = join(scratch.path, 'plugins', PACKAGE_NAME, `v${version}`)
  const threadFile = join(directory, 'threads', `${healthyId}.json`)
  const snapshotFile = join(directory, 'snapshots', `${healthyId}.json`)
  const record = makeRecord(healthyId)
  record.snapshot.system = 'x'.repeat(256 * 1024)
  const store = makeStore(path)
  const { signal } = new AbortController()
  const opened = await store.open(sessionId, signal)
  await opened.put(record)
  await utimes(snapshotFile, new Date(0), new Date(0))
  const originalSnapshotStats = await stat(snapshotFile)
  const updated = {
    ...record, version: 2,
    turns: [{ ...record.turns[0], reply: 'extended answer' }],
  }
  await opened.put(updated)
  const reopened = await store.open(sessionId, signal)
  const { snapshot, ...thread } = updated
  assert.deepEqual(reopened.records, [thread])
  assert.deepEqual(await reopened.loadSnapshot(healthyId), snapshot)
  const final = {
    ...updated, version: 3,
    turns: [{ ...updated.turns[0], reply: 'complete answer' }],
  }
  await reopened.put(final)
  const loaded = await store.open(sessionId, signal)
  const { snapshot: finalSnapshot, ...diskRecord } = final
  assert.deepEqual(loaded.records, [diskRecord])
  assert.deepEqual(await loaded.loadSnapshot(healthyId), finalSnapshot)
  assert.deepEqual(await readdir(join(directory, 'snapshots')), [`${healthyId}.json`])
  assert.deepEqual(JSON.parse(await readFile(snapshotFile, 'utf8')), record.snapshot)
  assert.equal((await stat(snapshotFile)).mtimeMs, originalSnapshotStats.mtimeMs)
  assert.ok((await stat(threadFile)).size < 1024)
  assert.deepEqual(JSON.parse(await readFile(threadFile, 'utf8')), { schemaVersion: 2, record: diskRecord })
  assert.equal(await readFile(path, 'utf8'), 'main transcript fixture\n')
})

test('interrupted inline migration keeps the legacy record readable', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'dsh-btw-interrupted-migration-'))
  const path = join(scratch.path, 'session.jsonl')
  const directory = join(scratch.path, 'plugins', PACKAGE_NAME, 'v0.0.9')
  const file = join(directory, 'threads', `${healthyId}.json`)
  await mkdir(join(directory, 'threads'), { recursive: true })
  await writeFile(path, 'main transcript fixture\n')
  const legacy = makeRecord(healthyId)
  await writeFile(file, JSON.stringify({ schemaVersion: 1, record: legacy }))
  const store = makeStore(path)
  const { signal } = new AbortController()
  const opened = await store.open(sessionId, signal)
  const edited = { ...legacy, version: 2 }
  const snapshotFile = join(directory, 'snapshots', `${healthyId}.json`)
  const stopped = new AbortController()
  const stopAfterSnapshotPublish = {
    throwIfAborted() {
      if (existsSync(snapshotFile)) stopped.abort()
      stopped.signal.throwIfAborted()
    },
  }
  await assert.rejects(opened.put(edited, stopAfterSnapshotPublish), { name: 'AbortError' })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { schemaVersion: 1, record: legacy })
  assert.deepEqual(JSON.parse(await readFile(snapshotFile, 'utf8')), legacy.snapshot)
  assert.deepEqual(await readdir(join(directory, 'threads')), [`${healthyId}.json`])
  const reopened = await store.open(sessionId, signal)
  assert.deepEqual(reopened.records, [legacy])
  await reopened.put(edited)
  const { snapshot, ...thread } = edited
  const loaded = await store.open(sessionId, signal)
  assert.deepEqual(loaded.records, [thread])
  assert.deepEqual(await loaded.loadSnapshot(healthyId), snapshot)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion, 2)
})

test('dangling and malformed snapshot files are isolated to their thread', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'dsh-btw-missing-snapshot-'))
  const path = join(scratch.path, 'session.jsonl')
  const directory = join(scratch.path, 'plugins', PACKAGE_NAME, 'v0.0.9')
  await mkdir(join(directory, 'threads'), { recursive: true })
  await mkdir(join(directory, 'snapshots'))
  await writeFile(path, 'main transcript fixture\n')
  const healthy = makeRecord(healthyId)
  await writeFile(join(directory, 'threads', `${healthyId}.json`), JSON.stringify({ schemaVersion: 1, record: healthy }))
  const { snapshot, ...unlinked } = makeRecord(newId)
  await writeFile(join(directory, 'snapshots', `${healthyId}.json`), JSON.stringify(null))
  const file = join(directory, 'threads', `${newId}.json`)
  const warnings = []
  const store = makeStore(path, (file, reason) => warnings.push([file, reason]))
  const { signal } = new AbortController()
  // An orphan from a write interrupted before publishing the thread is invisible.
  await writeFile(join(directory, 'snapshots', `${newId}.json`), JSON.stringify(snapshot))
  assert.deepEqual((await store.open(sessionId, signal)).records, [healthy])
  assert.deepEqual(warnings, [])
  await writeFile(file, JSON.stringify({ schemaVersion: 2, record: unlinked }))
  await writeFile(join(directory, 'snapshots', `${newId}.json`), '{')
  const missingId = 'btw-12345678-1234-1234-1234-123456789014'
  const otherFile = join(directory, 'threads', `${missingId}.json`)
  await writeFile(otherFile, JSON.stringify({ schemaVersion: 2, record: { ...unlinked, id: missingId } }))
  const opened = await store.open(sessionId, signal)
  assert.deepEqual(new Map(opened.records.map(record => [record.id, record])), new Map([
    [healthyId, healthy], [newId, unlinked], [missingId, { ...unlinked, id: missingId }],
  ]))
  assert.deepEqual(warnings, [])
  assert.equal(await opened.loadSnapshot(newId), undefined)
  assert.equal(await opened.loadSnapshot(missingId), undefined)
  assert.deepEqual(new Map(warnings), new Map([[file, 'invalid thread snapshot JSON'], [otherFile, 'missing thread snapshot']]))

  await writeFile(join(directory, 'snapshots', `${newId}.json`), JSON.stringify(snapshot))
  assert.deepEqual(await opened.loadSnapshot(newId), snapshot)
  assert.equal(await opened.loadSnapshot(missingId), undefined)
})
