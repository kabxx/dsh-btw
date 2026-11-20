import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { watchDetail } from '../src/client/views.js'

function harness(call) {
  let receive, fail
  const details = []
  const samples = []
  const errors = []
  const controller = {
    watchThread(session, id, onNext, onError) {
      assert.equal(session, 'main')
      assert.equal(id, 'thread')
      receive = onNext
      fail = onError
      return () => { receive = undefined }
    },
    call(name, session, id, signal) {
      assert.equal(name, 'contextCapacity')
      assert.equal(session, 'main')
      assert.equal(id, 'thread')
      return call(signal)
    },
    clearGeneratingNotice() {},
  }
  const dispose = watchDetail(controller, 'main', 'thread', {
    onDetail: detail => details.push(detail),
    onContext: sample => samples.push(sample),
    onError: error => errors.push(error),
  })
  return { dispose, details, samples, errors, send: event => receive(event), fail: error => fail(error) }
}

const settled = { status: 'completed', reply: 'First reply' }
const generating = { status: 'generating', reply: '' }
const baseline = turns => ({ kind: 'snapshot', detail: { id: 'thread', sessionId: 'main', version: 1, turns } })

test('a reconnected thread re-reads context even when its turn and status have not changed', async () => {
  let attempts = 0
  const view = harness(async () => {
    if (++attempts === 1) throw new Error('connection dropped')
    return { used: 200, contextWindow: 1000 }
  })
  try {
    const snapshot = baseline([settled])
    view.send(snapshot)
    await setImmediate()
    assert.equal(attempts, 1)
    assert.deepEqual(view.samples, [])

    view.fail(new Error('thread stream dropped'))
    view.send(snapshot)
    await setImmediate()
    assert.deepEqual(view.errors, ['streamFailed'])
    assert.deepEqual(view.details, [snapshot.detail, snapshot.detail])
    assert.equal(attempts, 2)
    assert.deepEqual(view.samples, [{ used: 200, contextWindow: 1000 }])
  } finally {
    view.dispose()
  }
})

test('reply deltas do not reload context and obsolete reads cannot overwrite newer samples', async () => {
  const reads = []
  const view = harness(signal => new Promise(resolve => reads.push({ signal, resolve })))
  try {
    view.send(baseline([generating]))
    await setImmediate()
    assert.equal(reads.length, 1)
    view.send({ kind: 'change', version: 2, firstTurn: 1, turns: [], reply: { offset: 0, text: 'A', status: 'generating' } })
    await setImmediate()
    assert.equal(reads.length, 1)

    view.send({ kind: 'change', version: 3, firstTurn: 1, turns: [], reply: { offset: 1, text: '', status: 'completed' } })
    await setImmediate()
    assert.equal(reads.length, 2)
    assert.equal(reads[0].signal.aborted, true)
    reads[1].resolve({ used: 22, contextWindow: 1000 })
    reads[0].resolve({ used: 10, contextWindow: 1000 })
    await setImmediate()
    assert.deepEqual(view.samples, [{ used: 22, contextWindow: 1000 }])

    view.send({ kind: 'change', version: 4, firstTurn: 1, turns: [generating] })
    await setImmediate()
    assert.equal(reads.length, 3)
  } finally {
    view.dispose()
  }
  assert.equal(reads.at(-1).signal.aborted, true)
  reads.at(-1).resolve({ used: 30, contextWindow: 1000 })
  await setImmediate()
  assert.deepEqual(view.samples, [{ used: 22, contextWindow: 1000 }])
})
