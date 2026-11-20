import assert from 'node:assert/strict'
import { mkdir, mkdtemp, mkdtempDisposable, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import BtwService, { BtwHost, threadSchema } from '../src/host/index.js'
import { sessionThreadStore } from '../src/host/session-store.js'
import { TYPERT } from '../src/host/typert.js'
import { CONTEXT_OVERFLOW, TYPERT_REMOTE, applyThreadEvent, parseDetail } from '../src/shared/wire.js'

const dshPackage = process.env.DSH_INSTALL_DIR
  ? resolve(process.env.DSH_INSTALL_DIR, 'package.json')
  : import.meta.url
const fromDsh = name => import(pathToFileURL(createRequire(dshPackage).resolve(name)).href)
const [
  { Context }, { TypertRegistry }, { TypertGatewayService }, { Session }, { DeepSeekAdapter },
  { default: LlmRuntime, isAgentLoopRequest, markAgentLoopRequest }, piAiPlugin, { createScope },
] = await Promise.all([
  fromDsh('@deepseek-ai/cordis'),
  fromDsh('@deepseek-ai/dsh-typert-registry'),
  fromDsh('@deepseek-ai/dsh-api-gateway'),
  fromDsh('@deepseek-ai/dsh-session'),
  fromDsh('@deepseek-ai/dsh-llm-deepseek'),
  fromDsh('@deepseek-ai/dsh-llm'),
  fromDsh('@deepseek-ai/dsh-llm-pi-ai'),
  fromDsh('@deepseek-ai/dsh-scope'),
])

function memoryStore(saved = new Map(), afterPut) {
  return {
    saved,
    async open(sessionId) {
      return {
        records: [...saved.values()].filter(record => record.sessionId === sessionId),
        async put(record) {
          assert.equal(record.sessionId, sessionId)
          saved.set(record.id, structuredClone(threadSchema.parse(record)))
          afterPut?.(record)
        },
      }
    },
  }
}

async function sessionFolder(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-btw-session-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'session.v4.jsonl.zstd')
  await writeFile(path, 'main transcript fixture')
  const archiveFile = id => join(directory, 'plugins', '@kabxx', 'dsh-btw', `v${process.env.npm_package_version ?? '0.1.0'}`, 'threads', `${id}.json`)
  return {
    directory, location: { kind: 'jsonl', path }, archiveFile,
    async read(id) {
      const envelope = JSON.parse(await readFile(archiveFile(id), 'utf8'))
      assert.equal(envelope.schemaVersion, 1)
      return envelope.record
    },
  }
}

function makeAgent(id) {
  const session = {
    id,
    messages: [],
    surface: { nodes: [] },
    append() { assert.fail('BTW wrote a main event') },
    deriveMessages() { return [...this.messages] },
  }
  const selected = { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'high' }
  return { session, selected, model: { current: () => selected } }
}

function msg(id, role, text, extra = []) {
  return {
    id, role, source: { kind: role === 'assistant' ? 'model' : role },
    content: [{ type: 'text', text }, ...extra],
  }
}

function controlledModel() {
  const calls = []
  let countChanged = Promise.withResolvers()
  return {
    calls,
    async waitForCount(count) {
      while (calls.length < count) await countChanged.promise
      return calls[count - 1]
    },
    async *stream(options) {
      let changed = Promise.withResolvers()
      const pending = []
      const call = {
        options,
        emit(chunk) {
          pending.push(chunk)
          changed.resolve()
        },
      }
      calls.push(call)
      countChanged.resolve()
      countChanged = Promise.withResolvers()
      const onAbort = () => changed.resolve()
      options.signal.addEventListener('abort', onAbort, { once: true })
      try {
        while (!options.signal.aborted) {
          if (pending.length === 0) await changed.promise
          changed = Promise.withResolvers()
          for (let chunk; (chunk = pending.shift());) {
            yield chunk
            if (chunk.type === 'finish') return
          }
        }
        options.signal.throwIfAborted()
      } finally {
        options.signal.removeEventListener('abort', onAbort)
      }
    },
  }
}

const text = (value, index = 0) => ({ type: 'text-delta', index, text: value })
const finish = (kind = 'stop') => ({ type: 'finish', reason: { kind } })
const latest = record => record.turns.at(-1)
const allText = options => options.messages.flatMap(message => message.content.map(block => block.text)).join('\n')

async function terminal(reads) {
  let last
  for await (const detail of reads) last = detail
  return last
}

test('session storage keeps different sessions and creation versions separate', async t => {
  const first = await sessionFolder(t)
  const second = await sessionFolder(t)
  const persistence = { stat: async id => ({ location: id === 'session-A' ? first.location : second.location }) }
  const store = sessionThreadStore(persistence, record => threadSchema.parse(record))
  const signal = new AbortController().signal
  const id = 'btw-12345678-1234-1234-1234-123456789012'
  const now = Date.now()
  const record = {
    id, sessionId: 'session-A', question: 'question', createdAt: now, updatedAt: now, version: 1,
    route: { provider: 'fixture-provider', model: 'fixture-model' },
    snapshot: { mode: 'native', anchor: null, messages: [] },
    turns: [{ question: 'question', reply: 'answer', status: 'completed', createdAt: now, finishedAt: now }],
  }
  const originalVersionFile = join(first.directory, 'plugins', '@kabxx', 'dsh-btw', 'v0.0.9', 'threads', `${id}.json`)
  await mkdir(dirname(originalVersionFile), { recursive: true })
  await writeFile(originalVersionFile, JSON.stringify({ schemaVersion: 1, record }))
  const reopened = await store.open('session-A', signal)
  assert.deepEqual(reopened.records, [record])
  const isolated = await store.open('session-B', signal)
  assert.deepEqual(isolated.records, [])
  await reopened.put({ ...record, version: 2 })
  assert.equal(JSON.parse(await readFile(originalVersionFile, 'utf8')).record.version, 2)
  await assert.rejects(readFile(first.archiveFile(id)), { code: 'ENOENT' })
})

test('an old Host stops writing before the successor takes over the session', { timeout: 5000 }, async t => {
  const fixture = await sessionFolder(t)
  const archive = sessionThreadStore({ stat: async () => ({ location: fixture.location }) }, record => threadSchema.parse(record))
  const oldWriteEntered = Promise.withResolvers()
  const oldWriteFinished = Promise.withResolvers()
  const releaseOldWrite = Promise.withResolvers()
  let holdOldCheckpoint = true
  const oldStore = {
    async open(...args) {
      const opened = await archive.open(...args)
      return {
        records: opened.records,
        async put(record, signal) {
          if (!holdOldCheckpoint || latest(record).reply !== 'uncommitted old fragment') {
            return opened.put(record, signal)
          }
          holdOldCheckpoint = false
          oldWriteEntered.resolve()
          await releaseOldWrite.promise
          try {
            await opened.put(record, signal)
            oldWriteFinished.resolve({ saved: true })
          } catch (error) {
            oldWriteFinished.resolve({ error })
            throw error
          }
        },
      }
    },
  }
  const modelA = controlledModel()
  const modelB = controlledModel()
  const hostA = new BtwHost({ store: oldStore, llm: modelA })
  const hostB = new BtwHost({ store: archive, llm: modelB })
  const ownerA = makeAgent('handoff')
  const agentScope = createScope(new Context(), ownerA)
  ownerA.ctx = agentScope.ctx
  const ownerB = makeAgent('handoff')
  const returned = makeAgent('handoff')
  try {
    await hostA.prepare('handoff', undefined, ownerA)
    const { id } = await hostA.create(ownerA, 'first question')
    const oldCall = await modelA.waitForCount(1)
    oldCall.emit(text('uncommitted old fragment'))
    await oldWriteEntered.promise
    // AgentLoop disposes this scope before releasing the session lease, and
    // emits agent/disposed later. Let B take over before delivering that event.
    await agentScope.dispose()
    await hostB.prepare('handoff', undefined, ownerB)
    releaseOldWrite.resolve()
    assert.equal((await oldWriteFinished.promise).error?.name, 'AbortError')
    assert.equal(latest(await fixture.read(id)).status, 'interrupted')
    assert.equal(latest(await fixture.read(id)).reply, '')
    await assert.rejects(hostA.create(ownerA, 'late first question'))
    hostA.retire('handoff', ownerA)
    await hostB.followup('handoff', id, 'B follow-up')
    const callB = await modelB.waitForCount(1)
    callB.emit(text('B answer'))
    callB.emit(finish())
    await terminal(hostB.watch('handoff', id, null, () => {}))
    hostB.retire('handoff', ownerB)
    await hostA.prepare('handoff', undefined, returned)
    await hostA.followup('handoff', id, 'A follow-up')
    const callA = await modelA.waitForCount(2)
    callA.emit(text('A answer'))
    callA.emit(finish())
    await terminal(hostA.watch('handoff', id, null, () => {}))
    assert.deepEqual((await fixture.read(id)).turns.map(turn => [turn.question, turn.reply]), [
      ['first question', ''], ['B follow-up', 'B answer'], ['A follow-up', 'A answer'],
    ])
    assert.equal(await readFile(fixture.location.path, 'utf8'), 'main transcript fixture')
  } finally {
    releaseOldWrite.resolve()
    await Promise.all([hostA.close(), hostB.close()])
  }
})

test('side questions cannot recreate a removed main session directory', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'dsh-btw-removed-session-'))
  const sessionDir = join(scratch.path, 'session')
  const removedDir = join(scratch.path, 'removed')
  await mkdir(sessionDir)
  const location = { kind: 'jsonl', path: join(sessionDir, 'session.jsonl') }
  await writeFile(location.path, 'main transcript fixture')
  const store = sessionThreadStore({ stat: async () => ({ location }) }, record => threadSchema.parse(record))
  const llm = controlledModel()
  const host = new BtwHost({ store, llm })
  const agent = makeAgent('session-removed')
  try {
    assert.equal(await host.prepare(agent.session.id, undefined, agent), true)
    await rename(sessionDir, removedDir)
    await assert.rejects(host.create(agent, 'side question'), { code: 'btw/save-failed' })
    await assert.rejects(stat(sessionDir), { code: 'ENOENT' })
    assert.equal(await readFile(join(removedDir, 'session.jsonl'), 'utf8'), 'main transcript fixture')
    assert.equal(llm.calls.length, 0)
  } finally {
    await host.close()
  }
})

test('installed DSH strict Gateway lookup, owner authorization and business APIs', { timeout: 10_000 }, async t => {
  const ctx = new Context()
  const llm = controlledModel()
  const modelInfoCalls = []
  llm.resolveModelInfo = async (provider, model, signal) => {
    modelInfoCalls.push([provider, model])
    signal.throwIfAborted()
    return { provider, id: model, name: model, context: { contextWindow: 128_000 } }
  }
  const folder = await sessionFolder(t)
  const agentA = makeAgent('session-A')
  const agentB = makeAgent('session-B')
  const agents = new Map([[agentA.session.id, agentA], [agentB.session.id, agentB]])
  let lookups = 0
  let persisted
  let statFailure
  const statCalls = []
  ctx.provide('agents', { get: id => agents.get(id) })
  ctx.provide('sessionPersistence', {
    async stat(id, { signal }) {
      signal?.throwIfAborted()
      statCalls.push(id)
      if (statFailure) throw statFailure
      return id === 'session-A' ? persisted : undefined
    },
  })
  ctx.provide('llm', llm)
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: 'no-allow' }) })
  await ctx.plugin(TypertRegistry)
  ctx.typert.register(TYPERT)
  ctx.typert.lookups.register('agent', {
    parameter: 'agent', wire: 'agentId', resource: 'session', hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
    wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    resolve(id) { lookups++; return agents.get(id) },
  })
  const fiber = ctx.plugin(BtwService)
  await fiber
  await ctx.plugin(TypertGatewayService)
  const peerController = new AbortController()
  const peer = { id: 'owner-fixture', principal: { kind: 'owner' }, signal: peerController.signal, ctx }
  const guest = { ...peer, id: 'guest-fixture', principal: { kind: 'guest' } }
  const invoke = (method, args, caller = peer, signal) => ctx.typertGateway.invoke({ namespace: 'btw', method, args, peer: caller, signal })
  try {
    assert.deepEqual([...TYPERT.invocations, ctx.typert.local.get('btw/contextCapacity'), ctx.typert.local.get('btw/watchThread')], TYPERT_REMOTE.descriptors)
    await assert.rejects(invoke('list', { agentId: 'session-A' }, guest), error => error.code === 'remote-access/denied')
    assert.equal(lookups, 0, 'non-owner was refused before the session lookup')
    await assert.rejects(invoke('list', { agentId: 'session-missing' }))
    await assert.rejects(invoke('list', { agentId: 'session-A', unexpected: true }))
    await assert.rejects(invoke('create', { agentId: 'session-A', question: ' \n ' }))
    assert.deepEqual(await invoke('list', { agentId: 'session-A' }), [])
    assert.deepEqual(statCalls, ['session-A'], 'listing tolerates a missing session directory')
    const createFirst = () => invoke('create', { agentId: 'session-A', question: ' side first ' })
    const expectedRejection = error => error.code === 'btw/session-not-saved'
      && error.message === '请先发送一条消息开始侧问'
    await assert.rejects(createFirst(), expectedRejection)
    persisted = { header: {}, revision: 'pending' }
    await assert.rejects(createFirst(), expectedRejection)
    persisted = { location: { kind: 'database', path: folder.location.path } }
    await assert.rejects(createFirst(), expectedRejection)
    persisted = { location: { kind: 'jsonl', path: join(folder.directory, 'missing', 'session.jsonl') } }
    await assert.rejects(createFirst(), expectedRejection)
    statFailure = new Error('fixture persistence query failed')
    await assert.rejects(createFirst(), error => error.code !== 'btw/session-not-saved')
    statFailure = undefined
    assert.equal(statCalls.length, 6)
    assert.ok(statCalls.every(id => id === 'session-A'))
    assert.equal(llm.calls.length, 0)
    persisted = { location: folder.location }
    agentA.session.messages.push(msg('m1', 'user', 'frozen main text'))
    agentA.session.messages.push(msg('m2', 'assistant', 'frozen main reply', [
      { type: 'reasoning', text: 'PRIVATE REASONING' },
      { type: 'tool-call', id: 'previous-call', name: 'historical', arguments: '{}' },
    ]))
    agentA.session.messages.push({ ...msg('m3', 'tool', 'PRIVATE TOOL RESULT'), toolCallId: 'previous-call' })
    agentA.session.surface.nodes.push(7)
    const first = await invoke('create', { agentId: 'session-A', question: ' side first ' })
    assert.deepEqual(parseDetail(first), first)
    assert.equal(first.question, ' side first ')
    assert.equal(latest(first).status, 'generating')
    assert.equal((await folder.read(first.id)).snapshot.anchor, 7)
    assert.equal(Object.hasOwn(first, 'route'), false)
    assert.equal(Object.hasOwn(first, 'snapshot'), false)
    const call = await llm.waitForCount(1)
    assert.equal(call.options.provider, 'fixture-provider')
    assert.equal(call.options.reasoningEffort, 'high')
    assert.equal(call.options.sessionId, undefined)
    assert.equal(call.options.tools, undefined)
    assert.equal(call.options.toolHistory, undefined)
    assert.match(allText(call.options), /frozen main text/)
    assert.match(allText(call.options), /PRIVATE REASONING[\s\S]*PRIVATE TOOL RESULT/)
    assert.deepEqual(call.options.messages.slice(0, -1), agentA.session.messages)
    assert.match(allText(call.options), /Do not call tools[\s\S]*Question:\n side first $/)

    await assert.rejects(invoke('get', { agentId: 'session-B', id: first.id }), error => error.code === 'btw/not-found')
    assert.deepEqual(await invoke('list', { agentId: 'session-B' }), [])
    const list = await invoke('list', { agentId: 'session-A' })
    assert.equal(list.length, 1)
    assert.equal(list[0].status, 'generating')
    assert.equal(Object.hasOwn(list[0], 'turns'), false)
    await assert.rejects(invoke('followup', { agentId: 'session-A', id: first.id, question: 'too soon' }), error => error.code === 'btw/generating')

    const watch = async (version, signal) => (await ctx.typertGateway.stream({
      namespace: 'btw', method: 'watch', args: { agentId: 'session-A', id: first.id, ...(version === undefined ? {} : { version }) }, peer, signal,
    }))[Symbol.asyncIterator]()
    const watchSignal = new AbortController()
    const reader = await watch(undefined, watchSignal.signal)
    assert.equal((await reader.next()).value.version, first.version)
    const next = reader.next()
    call.emit({ type: 'tool-call-delta', index: 3, id: 'tool-call-1', name: 'forbidden', argumentsDelta: '{}' })
    call.emit(text('visible text'))
    const partial = (await next).value
    assert.equal(latest(partial).reply, 'visible text')
    watchSignal.abort()
    await reader.return()
    assert.equal(call.options.signal.aborted, false)

    const resumed = await watch(partial.version)
    const result = resumed.next()
    call.emit({ type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 1200, other: 'ignored' } })
    call.emit(finish())
    const completed = (await result).value
    assert.equal(latest(completed).status, 'completed')
    assert.deepEqual(latest(completed).usage, { inputTokens: 10, outputTokens: 4, cacheReadTokens: 1200 })
    assert.equal(latest((await folder.read(first.id))).usage.cacheReadTokens, 1200)
    assert.equal((await resumed.next()).done, true)

    const detailArgs = { agentId: 'session-A', id: first.id }
    const initialContext = await invoke('contextCapacity', detailArgs)
    assert.equal(initialContext.contextWindow, 128_000)
    assert.ok(initialContext.estimatedTokens > 1_210, 'includes the first reply beyond billed prompt tokens')

    agentA.session.messages.push(msg('m4', 'user', 'NEW MAIN text'))
    agentA.selected.model = 'new-model'
    const tabA = new AbortController()
    const tabB = new AbortController()
    const otherPeer = { ...peer, id: 'owner-second-tab' }
    const subscribe = async (caller, signal) => (await ctx.typertGateway.stream({
      namespace: 'btw', method: 'watchThread', args: detailArgs, peer: caller, signal,
    }))[Symbol.asyncIterator]()
    const tabAStream = await subscribe(peer, tabA.signal)
    const tabBStream = await subscribe(otherPeer, tabB.signal)
    let tabADetail = applyThreadEvent(undefined, (await tabAStream.next()).value)
    let tabBDetail = applyThreadEvent(undefined, (await tabBStream.next()).value)
    assert.deepEqual(tabADetail, completed)
    assert.deepEqual(tabBDetail, completed)
    const firstUpdateInA = tabAStream.next()
    const firstUpdateInB = tabBStream.next()
    const followup = await invoke('followup', { ...detailArgs, question: 'continue here' }, otherPeer)
    const admitted = (await firstUpdateInA).value
    tabADetail = applyThreadEvent(tabADetail, admitted)
    tabBDetail = applyThreadEvent(tabBDetail, (await firstUpdateInB).value)
    assert.deepEqual(tabADetail, tabBDetail)
    assert.equal(admitted.kind, 'change')
    assert.equal(admitted.firstTurn, 1)
    assert.deepEqual(admitted.turns, [followup.turn])
    assert.equal(latest(tabADetail).status, 'generating')
    await assert.rejects(invoke('followup', { ...detailArgs, question: 'too soon from another tab' }), error => error.code === 'btw/generating')
    assert.equal(followup.turnIndex, 1)
    assert.equal(followup.turn.question, 'continue here')
    assert.equal(Object.hasOwn(followup, 'turns'), false)
    const secondCall = await llm.waitForCount(2)
    assert.equal(secondCall.options.model, 'fixture-model')
    assert.match(allText(secondCall.options), /frozen main text/)
    assert.match(allText(secondCall.options), / side first [\s\S]*visible text[\s\S]*Do not call tools[\s\S]*Question:\ncontinue here$/)
    assert.doesNotMatch(allText(secondCall.options), /NEW MAIN/)
    const sidebar = async (version, turnIndex = 1) => (await ctx.typertGateway.stream({
      namespace: 'btw', method: 'watchReply', args: { agentId: 'session-A', id: first.id, turnIndex, version }, peer,
    }))[Symbol.asyncIterator]()
    // A first piece of output may arrive before the browser opens the second-turn stream.
    const secondWatch = await watch(followup.version)
    const started = secondWatch.next()
    const prefixInA = tabAStream.next()
    secondCall.emit(text('可以'))
    tabADetail = applyThreadEvent(tabADetail, (await prefixInA).value)
    assert.equal(latest((await started).value).reply, '可以')
    await secondWatch.return()
    const reader2 = await sidebar(followup.version)
    const prefix = (await reader2.next()).value
    assert.deepEqual({ text: prefix.text, offset: prefix.offset, status: prefix.status }, { text: '可以', offset: 0, status: 'generating' })
    assert.equal(Object.hasOwn(prefix, 'turns'), false)
    const deltaPending = reader2.next()
    const deltaInA = tabAStream.next()
    secondCall.emit(text('复用'))
    const suffixInA = (await deltaInA).value
    assert.equal(suffixInA.reply.offset, 2)
    assert.equal(suffixInA.reply.text, '复用')
    assert.deepEqual(suffixInA.turns, [])
    tabADetail = applyThreadEvent(tabADetail, suffixInA)
    const delta = (await deltaPending).value
    assert.deepEqual({ text: delta.text, offset: delta.offset, status: delta.status }, { text: '复用', offset: 2, status: 'generating' })
    const terminalPending = reader2.next()
    const terminalInA = tabAStream.next()
    secondCall.emit({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 4 } })
    secondCall.emit(finish())
    const done = (await terminalPending).value
    assert.deepEqual({ text: done.text, offset: done.offset, status: done.status }, { text: '', offset: 4, status: 'completed' })
    assert.deepEqual(done.usage, { inputTokens: 3, outputTokens: 2, cacheReadTokens: 4 })
    assert.ok(Number.isSafeInteger(done.timing.firstTokenMs))
    assert.ok(done.timing.requestMs >= done.timing.firstTokenMs)
    assert.deepEqual(latest((await folder.read(first.id))).timing, done.timing)
    assert.equal((await reader2.next()).done, true)
    const detail = await invoke('get', detailArgs)
    tabADetail = applyThreadEvent(tabADetail, (await terminalInA).value)
    tabBDetail = applyThreadEvent(tabBDetail, (await tabBStream.next()).value)
    assert.deepEqual(tabADetail, detail)
    assert.deepEqual(tabBDetail, detail, 'a delayed reader catches up without resending old turns')
    tabA.abort()
    tabB.abort()
    await Promise.all([tabAStream.return(), tabBStream.return()])
    assert.deepEqual(detail.turns.map(turn => turn.reply), ['visible text', '可以复用'])
    assert.deepEqual(parseDetail(detail), detail)
    const followupContext = await invoke('contextCapacity', detailArgs)
    assert.equal(followupContext.contextWindow, 128_000)
    assert.ok(followupContext.estimatedTokens > initialContext.estimatedTokens, 'appended turns count even if latest usage sample falls')
    assert.deepEqual(modelInfoCalls, [['fixture-provider', 'fixture-model'], ['fixture-provider', 'fixture-model']])
    assert.equal(Object.hasOwn(await folder.read(first.id), 'contextWindow'), false)
    assert.equal(await readFile(folder.location.path, 'utf8'), 'main transcript fixture')

    llm.resolveModelInfo = async () => ({})
    assert.deepEqual(await invoke('contextCapacity', detailArgs), { contextWindow: null })
    llm.resolveModelInfo = async () => { throw new Error('stored route is no longer registered') }
    assert.deepEqual(await invoke('contextCapacity', detailArgs), { contextWindow: null })
    assert.deepEqual(await invoke('get', detailArgs), detail)

    const caller = new AbortController()
    const lookupStarted = Promise.withResolvers()
    llm.resolveModelInfo = async (_provider, _model, signal) => {
      lookupStarted.resolve(signal)
      await new Promise(resolveAbort => signal.addEventListener('abort', resolveAbort, { once: true }))
      signal.throwIfAborted()
    }
    const pendingContext = invoke('contextCapacity', detailArgs, peer, caller.signal)
    const cancelledContext = assert.rejects(pendingContext, error => error.code === 'gateway/cancelled')
    const lookupSignal = await lookupStarted.promise
    assert.deepEqual(await invoke('get', detailArgs), detail)
    caller.abort()
    await cancelledContext
    assert.equal(lookupSignal.aborted, true)
  } finally {
    peerController.abort()
    await fiber.dispose()
  }
})

test('two BTW runs overlap and restart marks a saved partial as interrupted', { timeout: 10_000 }, async () => {
  const llm = controlledModel()
  const checkpoint = Promise.withResolvers()
  const domain = memoryStore(undefined, record => {
    if (latest(record).reply === 'saved partial' && latest(record).status === 'generating') checkpoint.resolve(record)
  })
  const host = new BtwHost({ store: domain, llm })
  try {
    const agent = makeAgent('session-A')
    const a = await host.create(agent, 'first')
    const first = await llm.waitForCount(1)
    const b = await host.create(agent, 'second')
    const second = await llm.waitForCount(2)
    assert.equal(host.get(a.sessionId, a.id).turns[0].status, 'generating')
    const bDone = terminal(host.watch(b.sessionId, b.id, undefined, () => {}))
    second.emit(text('second completed'))
    second.emit(finish())
    assert.equal(latest(await bDone).status, 'completed')
    assert.equal(first.options.signal.aborted, false)
    const partialWatch = host.watch(a.sessionId, a.id, a.version, () => {})
    const observed = partialWatch.next()
    first.emit(text('saved partial'))
    assert.equal(latest((await observed).value).reply, 'saved partial')
    await partialWatch.return()
    const stored = await checkpoint.promise
    assert.equal(first.options.signal.aborted, false)
    // A service restart opens the last saved checkpoint; no provider request is replayed.
    const restartedDomain = memoryStore(new Map([[a.id, domain.saved.get(a.id)]]))
    const restarted = new BtwHost({ store: restartedDomain, llm: { stream() { assert.fail('unexpected replay') } } })
    try {
      await restarted.prepare(a.sessionId)
      const recovered = await terminal(restarted.watch(a.sessionId, a.id, undefined, () => {}))
      assert.equal(latest(recovered).status, 'interrupted')
      assert.equal(latest(recovered).reply, 'saved partial')
      assert.ok(latest(recovered).finishedAt)
      assert.ok(recovered.version > stored.version)
    } finally {
      await restarted.close()
    }
  } finally {
    await host.close()
  }
})

test('BTW does not impose its own generation deadline and still stops when Host closes', { timeout: 10_000 }, async t => {
  const deadlines = []
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    deadlines.push(milliseconds)
    return AbortSignal.abort()
  })
  const domain = memoryStore()
  const llm = controlledModel()
  const host = new BtwHost({ store: domain, llm })
  let closed = false
  try {
    const record = await host.create(makeAgent('session-A'), 'keep streaming')
    const call = await llm.waitForCount(1)
    assert.deepEqual(deadlines, [])
    assert.equal(call.options.signal.aborted, false)
    const watch = host.watch(record.sessionId, record.id, record.version, () => {})
    const partial = watch.next()
    call.emit(text('partial before Host closed'))
    assert.equal(latest((await partial).value).reply, 'partial before Host closed')
    await watch.return()
    await host.close()
    closed = true
    assert.equal(call.options.signal.aborted, true)
    assert.equal(latest(domain.saved.get(record.id)).status, 'interrupted')
    assert.equal(latest(domain.saved.get(record.id)).reply, 'partial before Host closed')
  } finally {
    if (!closed) await host.close()
  }
})

test('BTW replays all eligible frozen text and prior turns without plugin size caps', { timeout: 10_000 }, async () => {
  const domain = memoryStore()
  const llm = controlledModel()
  const host = new BtwHost({ store: domain, llm })
  const agent = makeAgent('session-long-btw')
  const snapshot = Array.from({ length: 30 }, (_, i) => `main ${i}: ${'m'.repeat(i === 0 ? 20_040 : 70)}`)
  for (const [i, value] of snapshot.entries()) agent.session.messages.push(msg(`main-${i}`, 'user', value))
  const sessionId = agent.session.id
  const question = i => `question ${i}: ${'x'.repeat(i <= 2 ? 12_020 : 610)}`
  const reply = i => i === 1 ? `first reply ${'r'.repeat(33_000)} end` : `reply ${i}`
  let record
  let previousRequest
  try {
    for (let i = 1; i <= 30; i++) {
      record = i === 1
        ? await host.create(agent, question(i))
        : await host.followup(sessionId, record.id, question(i))
      const call = await llm.waitForCount(i)
      const request = call.options.messages
      assert.equal(Object.hasOwn(call.options, 'maxTokens'), false)
      assert.equal(request.at(-1).content[0].text.endsWith(`\nQuestion:\n${question(i)}`), true)
      if (i === 1) {
        assert.deepEqual(request.slice(0, -1).map(message => message.content[0].text), snapshot)
        assert.deepEqual(domain.saved.get(record.id).snapshot.messages.map(message => message.content[0].text), snapshot)
        agent.session.messages.push(msg('later', 'user', 'Not part of the frozen snapshot'))
      } else {
        assert.deepEqual(request.slice(0, -2), previousRequest)
        assert.equal(request.at(-2).content[0].text, reply(i - 1))
      }
      previousRequest = request
      const done = terminal(host.watch(sessionId, record.id, undefined, () => {}))
      if (i === 1) {
        call.emit(text(reply(i).slice(0, 32_010)))
        call.emit(text(reply(i).slice(32_010)))
      } else {
        call.emit(text(reply(i)))
      }
      call.emit(finish())
      record = await done
      assert.equal(latest(record).status, 'completed')
      assert.equal(latest(record).reply, reply(i))
    }
    assert.deepEqual(parseDetail(host.get(sessionId, record.id)).turns, record.turns)
    assert.equal(record.turns.length, 30)
    assert.equal(domain.saved.get(record.id).turns[0].reply, reply(1))
  } finally {
    await host.close()
  }
})

test('context overflow preserves intact side chat and blocks further model requests', { timeout: 10_000 }, async () => {
  const domain = memoryStore()
  const requests = []
  const llm = {
    async *stream(options) {
      requests.push(options.messages)
      const question = options.messages.at(-1).content[0].text
      if (question.endsWith('first question')) {
        yield text('previous answer')
        yield finish()
      } else if (question.endsWith('in-band overflow')) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'provider-only diagnostic' } } }
      } else {
        throw Object.assign(new Error('provider-only diagnostic'), { code: 'CONTEXT_WINDOW_EXCEEDED' })
      }
    },
  }
  const host = new BtwHost({ store: domain, llm })
  const agent = makeAgent('session-overflow')
  agent.session.messages.push(msg('m1', 'user', 'frozen context'))
  try {
    for (const question of ['in-band overflow', 'thrown overflow']) {
      const { id, sessionId } = await host.create(agent, 'first question')
      const first = await terminal(host.watch(sessionId, id, undefined, () => {}))
      await host.followup(sessionId, id, question)
      const detail = await terminal(host.watch(sessionId, id, undefined, () => {}))
      assert.equal(latest(detail).status, 'failed')
      assert.equal(latest(detail).error, CONTEXT_OVERFLOW)
      assert.equal(latest(detail).question, question)
      assert.deepEqual(detail.turns[0], first.turns[0])
      assert.deepEqual(domain.saved.get(id).snapshot.messages.map(message => message.content[0].text), ['frozen context'])
      assert.throws(() => host.followup(sessionId, id, 'do not send again'), error => error.code === 'btw/context-overflow')
    }
    assert.equal(requests.length, 4)
    assert.deepEqual(requests[1].slice(0, 2), requests[0])
    assert.equal(requests[3][2].content[0].text, 'previous answer')
  } finally {
    await host.close()
  }
})

test('native Session anchor and installed DeepSeek thinking-mode request serialization', { timeout: 10_000 }, async t => {
  assert.equal(typeof Session.create, 'function')
  const agent = makeAgent('session-native-fixture')
  agent.session = Session.create(agent.session.id)
  const firstEvent = agent.session.append('user/message', msg('main-user', 'user', 'native committed text'), { surfaceOp: 'append' })
  const replyEvent = agent.session.append('assistant/message', {
    turn: 0, step: 0, stream: [],
    message: { ...msg('main-assistant', 'assistant', 'native committed reply', [{ type: 'reasoning', text: 'PRIVATE REASONING' }]),
      source: { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' } },
  }, { surfaceOp: 'append' })
  assert.equal(typeof firstEvent.seq, 'number')
  assert.equal(agent.session.surface.nodes.at(-1), replyEvent.seq)
  const protocol = [
    { type: 'message_start', message: { usage: { input_tokens: 30 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'side text' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, request) => {
    assert.equal(request.headers['x-deepseek-harness-session-id'], undefined)
    return new Response(protocol, { headers: { 'content-type': 'text/event-stream' } })
  })
  const adapter = new DeepSeekAdapter({
    options: () => ({
      baseURL: 'https://deepseek-fixture.invalid', defaults: { thinking: 'enabled' }, models: [{ id: 'fixture-model', maxTokens: 8_192, contextWindow: 128_000 }],
      streamIdleTimeoutMs: 2000, filesApiTimeoutMs: 2000, filePolicy: {},
    }),
    resolveAuth: async () => ({ headers: {} }),
    resolveUserId: () => 'fixture-user',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
  const domain = memoryStore()
  const host = new BtwHost({ store: domain, llm: {
    async *stream(options) {
      try { yield* adapter.stream(options) }
      catch (error) { t.diagnostic(`${error.stack}\nCause: ${error.cause?.stack}`); throw error }
    },
  } })
  try {
    const record = await host.create(agent, 'first provider question')
    assert.equal(domain.saved.get(record.id).snapshot.anchor, replyEvent.seq)
    const detail = await terminal(host.watch(record.sessionId, record.id, undefined, () => {}))
    assert.equal(latest(detail).status, 'completed')
    assert.equal(latest(detail).reply, 'side text')
    const followup = await host.followup(record.sessionId, record.id, 'second provider question')
    const done = await terminal(host.watch(followup.sessionId, followup.id, undefined, () => {}))
    assert.equal(latest(done).status, 'completed')
    assert.equal(fetch.mock.callCount(), 2)
    assert.equal(Object.hasOwn(domain.saved.get(record.id).snapshot, 'maxTokens'), false)
    for (const call of fetch.mock.calls) assert.equal(JSON.parse(call.arguments[1].body).max_tokens, 8_192)
    const request = JSON.parse(fetch.mock.calls[1].arguments[1].body)
    assert.equal(request.thinking.type, 'enabled')
    assert.equal(request.output_config.effort, 'high')
    assert.equal(request.tools, undefined)
    assert.deepEqual(request.messages.map(row => row.role), ['user', 'assistant', 'user', 'assistant', 'user'])
    assert.equal(request.messages[1].content[0].text, 'native committed reply')
    assert.equal(request.messages[3].content[0].text, 'side text')
    assert.match(request.messages[4].content[0].text, /Do not call tools[\s\S]*second provider question/)
    assert.deepEqual(request.messages[1].content[1], { type: 'thinking', thinking: 'PRIVATE REASONING' })
    assert.equal(agent.session.seq, replyEvent.seq + 1, 'BTW must add zero native Session events')
  } finally {
    await host.close()
  }
})


test('native Cordis/LLM waterfall freezes and reuses the main request across restart', { timeout: 10_000 }, async t => {
  const ctx = new Context()
  const agent = makeAgent('session-native-loop')
  const signal = new AbortController().signal
  const folder = await sessionFolder(t)
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 15 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'provider reply' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    requests.push({ session: request.headers['x-deepseek-harness-session-id'], body: JSON.parse(request.body) })
    return new Response(frames, { headers: { 'content-type': 'text/event-stream' } })
  })
  let baselineMeasured = false
  ctx.provide('agents', { get: id => id === agent.session.id ? agent : undefined })
  ctx.provide('sessionPersistence', { stat: async () => ({ location: folder.location }) })
  ctx.provide('tokenMeter', { measure(session, header) {
    assert.equal(session, agent.session)
    assert.deepEqual(header.tools?.map(tool => tool.name), ['priorTool'])
    baselineMeasured = true
    return { totalTokens: 8_700 }
  } })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(LlmRuntime)
  const extensions = []
  const adapter = new DeepSeekAdapter({
    options: () => ({
      baseURL: 'https://deepseek-fixture.invalid', defaults: { thinking: 'enabled' }, models: [{ id: 'fixture-model', maxTokens: 8_192, contextWindow: 128_000 }],
      streamIdleTimeoutMs: 2000, filesApiTimeoutMs: 2000, filePolicy: {},
    }),
    resolveAuth: async () => ({ headers: {} }),
    resolveUserId: () => 'fixture-user',
    prepareExtensions: async request => {
      extensions.push(request.sessionId)
      return { fields: {}, accept: async () => {} }
    },
  })
  const disposeAdapter = ctx.llm.registerAdapter(['fixture-provider'], adapter)
  const fiber = ctx.plugin(BtwService)
  await fiber
  const tool = { name: 'priorTool', description: 'Prior Tool', parameters: { type: 'object' } }
  const messages = [
    msg('system', 'system', 'native system'),
    msg('user', 'user', 'native question'),
    { ...msg('assistant-call', 'assistant', '', [{ type: 'tool-call', id: 'native-call', name: 'priorTool', arguments: '{}' }]),
      source: { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' } },
    { ...msg('tool', 'tool', 'native tool result'), toolCallId: 'native-call' },
    { ...msg('assistant-reply', 'assistant', 'native assistant reply', [{ type: 'reasoning', text: 'native reasoning' }]),
      source: { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' } },
    msg('latest-user', 'user', 'main request currently waiting for answer'),
  ]
  agent.session.messages = [...messages]
  const main = await ctx.llm.prepareCall({ ...agent.selected, temperature: 0.1, maxTokens: 16 }, signal)
  agent.session.requestHeader = () => ({ config: main.config, adapterDefaults: main.adapterDefaults, tools: [tool] })
  const options = markAgentLoopRequest(Object.freeze({
    ...main.config, sessionId: agent.session.id, messages: Object.freeze([...messages]),
    tools: [tool], toolHistory: { tools: [tool], updates: [] }, signal,
  }))
  try {
    for await (const chunk of main.stream(options)) {
      if (chunk.type === 'finish') assert.equal(chunk.reason.kind, 'stop', JSON.stringify(chunk.reason))
    }
    assert.equal(requests.length, 1)
    const host = ctx.btw.host
    await host.prepare(agent.session.id)
    const { id, sessionId } = await host.create(agent, 'side question')
    const side = await terminal(host.watch(sessionId, id, undefined, () => {}))
    assert.equal(latest(side).status, 'completed')
    assert.equal(latest(side).usage.cacheReadTokens, 15)
    assert.equal(baselineMeasured, true)
    const saved = await folder.read(id)
    assert.equal(saved.snapshot.mode, 'native')
    assert.equal(saved.snapshot.measuredPrefix, 8_700)
    assert.equal(saved.snapshot.maxTokens, 16)
    assert.deepEqual(saved.snapshot.toolHistory, options.toolHistory)
    assert.deepEqual(saved.snapshot.messages, options.messages)
    assert.equal(Object.hasOwn(saved.snapshot, 'signal'), false)
    assert.equal(Object.hasOwn(saved.snapshot, 'sessionId'), false)
    assert.equal(Object.hasOwn(side, 'snapshot'), false)
    assert.equal(Object.hasOwn(latest(side), 'modelReply'), false)
    const [mainRequest, sideRequest] = requests
    assert.equal(mainRequest.session, agent.session.id)
    assert.equal(sideRequest.session, undefined)
    assert.deepEqual(extensions, [agent.session.id, undefined])
    assert.deepEqual(sideRequest.body.messages.slice(0, -1), mainRequest.body.messages.slice(0, -1))
    // Messages merges adjacent user rows; its original blocks remain the exact prefix.
    assert.deepEqual(sideRequest.body.messages.at(-1).content.slice(0, -1), mainRequest.body.messages.at(-1).content)
    assert.deepEqual(sideRequest.body.tools, mainRequest.body.tools)
    assert.equal(sideRequest.body.system, mainRequest.body.system)
    assert.equal(sideRequest.body.temperature, mainRequest.body.temperature)
    assert.equal(mainRequest.body.max_tokens, 16)
    assert.equal(sideRequest.body.max_tokens, 16)
    assert.match(sideRequest.body.messages.at(-1).content.at(-1).text, /Do not call tools[\s\S]*side question$/)
    await host.followup(sessionId, id, 'same process question')
    await terminal(host.watch(sessionId, id, undefined, () => {}))
    assert.equal(requests[2].body.max_tokens, 16)
    agent.session.messages = [msg('later', 'user', 'new main surface')]
    const reopened = new BtwHost({ store: sessionThreadStore(ctx.sessionPersistence, record => threadSchema.parse(record)), llm: ctx.llm })
    try {
      await reopened.prepare(sessionId)
      await reopened.followup(sessionId, id, 'reopened question')
      const done = await terminal(reopened.watch(sessionId, id, undefined, () => {}))
      assert.equal(latest(done).status, 'completed')
      assert.deepEqual(requests[3].body.messages.slice(0, -2), requests[2].body.messages)
      assert.equal(requests[3].body.max_tokens, 16)
      assert.doesNotMatch(JSON.stringify(requests[3]), /new main surface/)
    } finally {
      await reopened.close()
    }
  } finally {
    await fiber.dispose()
    disposeAdapter()
  }
})

test('side requests preserve explicit limits and resolve adapter defaults for their own calls', { timeout: 10_000 }, async () => {
  const llm = controlledModel()
  const archive = memoryStore()
  const host = new BtwHost({ store: archive, llm })
  const cases = [
    { label: 'matching header', options: { maxTokens: 16 }, expected: 16 },
    { label: 'observed adapter default', options: { maxTokens: 8192 }, defaulted: true, observe: true },
    { label: 'header adapter default', options: { maxTokens: 8192 }, defaulted: true },
    { label: 'other model', options: { model: 'other-model', maxTokens: 16 } },
  ]
  try {
    for (const [index, { label, options, defaulted, observe, expected }] of cases.entries()) {
      const agent = makeAgent(`session-output-limit-${index}`)
      const config = { ...agent.selected, ...options }
      agent.session.requestHeader = () => ({ config, adapterDefaults: defaulted ? { maxTokens: true } : undefined })
      if (observe) host.observeMain(agent.session, { ...config, messages: agent.session.messages })
      const { id, sessionId } = await host.create(agent, label)
      const call = await llm.waitForCount(index + 1)
      assert.equal(call.options.maxTokens, expected, label)
      assert.equal(Object.hasOwn(call.options, 'maxTokens'), expected !== undefined, label)
      assert.equal(archive.saved.get(id).snapshot.maxTokens, expected, label)
      call.emit(text('done'))
      call.emit(finish())
      await terminal(host.watch(sessionId, id, undefined, () => {}))
    }
  } finally {
    await host.close()
  }
})

test('native Responses reuses the main cache key only at transport, including after restart', { timeout: 10_000 }, async t => {
  const app = new Context()
  const agent = makeAgent('session-openai-cache-fixture')
  agent.selected.provider = 'responses-fixture'
  delete agent.selected.reasoningEffort
  agent.session.messages = [msg('sys', 'system', 'fixture system'), msg('initial', 'user', 'main question')]
  const tools = [{ name: 'fixture_tool', description: 'Fixture only', parameters: { type: 'object', properties: {} } }]
  const calls = []
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', content: [] }
  const part = { type: 'output_text', text: 'fixture answer', annotations: [] }
  const frames = [
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: part.text },
    { type: 'response.output_item.done', output_index: 0, item: { ...item, content: [part] } },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14, input_tokens_details: { cached_tokens: 4 } } } },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(String(url), 'https://responses-fixture.invalid/v1/responses')
    calls.push({ body: JSON.parse(request.body), session: new Headers(request.headers).get('session-id') })
    return new Response(frames, { headers: { 'content-type': 'text/event-stream' } })
  })
  const folder = await sessionFolder(t)
  app.provide('agents', { get: id => id === agent.session.id ? agent : undefined })
  app.provide('sessionPersistence', { stat: async () => ({ location: folder.location }) })
  app.provide('credentials', { resolve: async () => ({ value: 'sk-fixture' }) })
  await app.plugin(TypertRegistry)
  await app.plugin(LlmRuntime)
  const adapterFiber = app.plugin(piAiPlugin, { providers: { 'responses-fixture': {
    api: 'openai-responses', baseURL: 'https://responses-fixture.invalid/v1', apiKeyEnv: 'FIXTURE_KEY',
    models: [{ id: 'fixture-model', maxTokens: 1024, contextWindow: 2048, reasoningEfforts: false }],
  } } })
  await adapterFiber
  const seen = []
  app.on('llm/stream', (options, next) => {
    seen.push({ purpose: options.purpose, sessionId: options.sessionId, main: isAgentLoopRequest(options) })
    return next()
  })
  const service = app.plugin(BtwService)
  await service
  try {
    const main = markAgentLoopRequest(Object.freeze({
      ...agent.selected, messages: agent.session.messages, tools, sessionId: agent.session.id,
    }))
    for await (const chunk of app.llm.stream(main)) {
      if (chunk.type === 'finish') assert.equal(chunk.reason.kind, 'stop', JSON.stringify(chunk.reason))
    }
    const host = app.btw.host
    await host.prepare(agent.session.id)
    const { id, sessionId } = await host.create(agent, 'first side question')
    const side = await terminal(host.watch(sessionId, id, undefined, () => {}))
    assert.equal(latest(side).status, 'completed', JSON.stringify(latest(side)))
    assert.equal(latest(side).usage.cacheReadTokens, 4)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].body.prompt_cache_key, sessionId)
    assert.equal(calls[1].body.prompt_cache_key, calls[0].body.prompt_cache_key)
    assert.equal(calls[1].session, calls[0].session)
    assert.deepEqual(calls[1].body.tools, calls[0].body.tools)
    assert.deepEqual(calls[1].body.input.slice(0, calls[0].body.input.length), calls[0].body.input)
    assert.match(JSON.stringify(calls[1].body.input.at(-1)), /Do not call tools[\s\S]*first side question/)
    assert.equal(calls[1].body.max_output_tokens, calls[0].body.max_output_tokens)
    const saved = await folder.read(id)
    assert.equal(Object.hasOwn(saved.snapshot, 'sessionId'), false)
    const reopened = new BtwHost({ store: sessionThreadStore(app.sessionPersistence, record => threadSchema.parse(record)), llm: app.llm })
    try {
      await reopened.prepare(sessionId)
      await reopened.followup(sessionId, id, 'after restart')
      const done = await terminal(reopened.watch(sessionId, id, undefined, () => {}))
      assert.equal(latest(done).status, 'completed')
      assert.equal(calls[2].body.prompt_cache_key, calls[0].body.prompt_cache_key)
      assert.deepEqual(calls[2].body.input.slice(0, calls[1].body.input.length), calls[1].body.input)
      assert.deepEqual(seen, [
        { purpose: undefined, sessionId, main: true },
        { purpose: 'btw', sessionId: undefined, main: false },
        { purpose: 'btw', sessionId: undefined, main: false },
      ])
    } finally {
      await reopened.close()
    }
  } finally {
    await service.dispose()
    await adapterFiber.dispose()
  }
})

test('archive failure leaves the answer visible and failed attempt content does not replay', { timeout: 10_000 }, async () => {
  const llm = controlledModel()
  const domain = memoryStore()
  const openArchive = domain.open
  const checkpointFailed = Promise.withResolvers()
  const log = []
  let rejectArchive = true
  domain.open = async sessionId => {
    const archive = await openArchive(sessionId)
    return { ...archive, async put(record) {
      if (rejectArchive && latest(record).reply) {
        if (latest(record).status === 'generating') checkpointFailed.resolve()
        throw new Error('fixture archive unavailable')
      }
      await archive.put(record)
    } }
  }
  const host = new BtwHost({ store: domain, llm, logger: { error: message => log.push(message) } })
  try {
    const { id, sessionId, version } = await host.create(makeAgent('session-save-error'), 'first')
    const first = await llm.waitForCount(1)
    const firstUpdate = terminal(host.watchReply(sessionId, id, 0, version, () => {}))
    first.emit(text('saved only after fault resolves'))
    await checkpointFailed.promise
    assert.equal(first.options.signal.aborted, false)
    first.emit(finish())
    const firstDone = await firstUpdate
    assert.equal(firstDone.status, 'completed')
    assert.equal(firstDone.saveError, 'archive-write-failed')
    assert.equal(latest(host.get(sessionId, id)).reply, 'saved only after fault resolves')
    assert.equal(latest(domain.saved.get(id)).reply, '')
    assert.equal(log.length, 2)
    rejectArchive = false
    await host.followup(sessionId, id, 'failing question')
    const second = await llm.waitForCount(2)
    const secondDone = terminal(host.watch(sessionId, id, undefined, () => {}))
    second.emit(text('failed private partial'))
    second.emit({ type: 'finish', reason: { kind: 'error' } })
    assert.equal(latest(await secondDone).status, 'failed')
    assert.equal(latest(host.get(sessionId, id)).reply, 'failed private partial')
    await host.followup(sessionId, id, 'third')
    const third = await llm.waitForCount(3)
    assert.match(allText(third.options), /saved only after fault resolves[\s\S]*failing question/)
    assert.doesNotMatch(allText(third.options), /failed private partial/)
    third.emit(text('third reply'))
    third.emit(finish())
    await terminal(host.watch(sessionId, id, undefined, () => {}))
    assert.equal(Object.hasOwn(domain.saved.get(id).turns[0], 'saveError'), false)
  } finally {
    await host.close()
  }
})


test('native prefix ends at the last committed tool boundary without capping identifiers', { timeout: 10_000 }, async () => {
  const sessionId = 'session-' + 'x'.repeat(300)
  const store = memoryStore()
  const llm = controlledModel()
  const host = new BtwHost({ store, llm })
  const agent = makeAgent(sessionId)
  agent.session.messages = [msg('m'.repeat(300), 'system', 'new native system'), msg('input', 'user', 'committed input'),
    msg('pending', 'assistant', '', [{ type: 'tool-call', name: 'stillPending', id: 'call', arguments: '{}' }])]
  agent.selected.provider = 'provider-' + 'p'.repeat(300)
  try {
    const { id } = await host.create(agent, 'native safe-boundary question')
    const nextCall = await llm.waitForCount(1)
    assert.equal(nextCall.options.provider, agent.selected.provider)
    assert.deepEqual(nextCall.options.messages.slice(0, -1), agent.session.messages.slice(0, 2))
    assert.equal(store.saved.get(id).snapshot.anchor, null)
    nextCall.emit(text('new answer'))
    nextCall.emit(finish())
    await terminal(host.watch(sessionId, id, undefined, () => {}))
  } finally {
    await host.close()
  }
})
