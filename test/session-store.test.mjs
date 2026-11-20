import assert from 'node:assert/strict'
import fs, { mkdir, mkdtempDisposable, readFile, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { threadSchema } from '../src/host/index.js'
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
  return sessionThreadStore(persistence, record => threadSchema.parse(record), onMalformedRecord)
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
  assert.deepEqual(new Map(reopened.records.map(record => [record.id, record])), new Map([[healthy.id, healthy], [added.id, added]]))
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
    assert.deepEqual(new Map(reopened.records.map(record => [record.id, record])), new Map([[healthy.id, healthy], [added.id, added]]))

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
