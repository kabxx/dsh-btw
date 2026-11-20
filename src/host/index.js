import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import {
  CONTEXT_OVERFLOW, PACKAGE_NAME, TOKEN_FIELDS, contextDescriptor, parseDetail, parseQuestion, parseSessionId, parseSubmissionId, parseThreadId, parseVersion, submitFollowupDescriptor, threadDescriptor,
} from '../shared/wire.js'
import { sessionThreadStore } from './session-store.js'

const requireHere = createRequire(import.meta.url)
const requireFrom = []
if (process.env.DSH_INSTALL_DIR) {
  requireFrom.push(createRequire(resolve(process.env.DSH_INSTALL_DIR, 'package.json')))
}
if (process.argv[1]) {
  try {
    // The Web Host starts from the CLI entry, even when its shell-tool-only
    // environment variables are absent and the bundle is linked elsewhere.
    requireFrom.push(createRequire(realpathSync(process.argv[1])))
  } catch {
    // Inline or embedded launchers may provide only the package-local resolver.
  }
}
requireFrom.push(requireHere)
function fromDsh(name) {
  for (const locate of requireFrom) {
    let entry
    try {
      entry = locate.resolve(name)
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error
      continue
    }
    return import(pathToFileURL(entry).href)
  }
  throw new Error(`BTW could not resolve installed Host package ${name}`)
}
const [
  { Service }, { RemoteError, TypertRemoteService }, { z }, { estimateMessage, estimateToolsTokens },
  { BlockAssembler, CONTEXT_WINDOW_EXCEEDED_CODE, isAgentLoopRequest, isTokenDelta },
  { PiAiAdapter },
] = await Promise.all([
  fromDsh('@deepseek-ai/cordis'),
  fromDsh('@deepseek-ai/dsh-typert-protocol'),
  fromDsh('zod'),
  fromDsh('@deepseek-ai/dsh-token-meter/estimate'),
  fromDsh('@deepseek-ai/dsh-llm'),
  fromDsh('@deepseek-ai/dsh-llm-pi-ai'),
])

export const inject = ['agents', 'llm', 'sessionPersistence', 'typert']

const CHECKPOINT_INTERVAL_MS = 500
const PREVIEW_INTERVAL_MS = 45
const NO_TOOLS = 'Reply in text only. Do not call tools. Treat the preceding conversation as read-only reference context, and state what is missing if answering requires inspecting files or running commands.'
const INTERRUPTION = '回复已中断。'
const FAILURE = '回复生成失败。'
const NO_TEXT = '模型未返回文本内容。'
const ARCHIVE_ERROR = 'archive-write-failed'
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const providerKey = z.string().min(1)
const routeSchema = z.strictObject({
  provider: providerKey,
  model: providerKey,
  reasoningEffort: providerKey.optional(),
})
const nativeBlock = z.looseObject({ type: z.string().min(1) })
const nativeMessage = z.looseObject({
  id: z.string().min(1),
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.array(nativeBlock),
  source: z.looseObject({ kind: z.string().min(1) }),
})
const toolSchema = z.looseObject({
  name: z.string(), description: z.string(), parameters: z.record(z.string(), z.json()),
})
const nativeSnapshot = z.strictObject({
  mode: z.literal('native'),
  anchor: timestamp.nullable(),
  messages: z.array(nativeMessage),
  system: z.string().optional(),
  tools: z.array(toolSchema).optional(),
  toolHistory: z.strictObject({
    tools: z.array(toolSchema),
    updates: z.array(z.strictObject({ messageId: z.string(), additions: z.array(toolSchema) })),
  }).optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  stop: z.array(z.string()).optional(),
  measuredPrefix: tokenCount.optional(),
})
const turnSchema = z.strictObject({
  submissionId: z.string().refine(value => {
    try { parseSubmissionId(value); return true } catch { return false }
  }).optional(),
  question: z.string().min(1),
  reply: z.string(),
  status: z.enum(['generating', 'completed', 'failed', 'interrupted']),
  createdAt: timestamp,
  finishedAt: timestamp.optional(),
  error: z.string().optional(),
  saveError: z.string().optional(),
  modelReply: nativeMessage.optional(),
  usage: z.strictObject(Object.fromEntries(TOKEN_FIELDS.map(key => [key, tokenCount.optional()]))).optional(),
  timing: z.strictObject({ requestMs: timestamp, firstTokenMs: timestamp.optional() }).optional(),
})
export const threadSchema = z.strictObject({
  id: z.string(),
  sessionId: z.string(),
  question: z.string().min(1),
  createdAt: timestamp,
  updatedAt: timestamp,
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  turns: z.array(turnSchema).min(1),
  route: routeSchema,
  snapshot: nativeSnapshot,
}).superRefine((record, context) => {
  try {
    parseDetail(toDetailShape(record))
    if (record.question !== record.turns[0].question || record.turns.slice(0, -1).some(turn => turn.status === 'generating')) {
      throw new Error('invalid thread history')
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid BTW thread record' })
  }
})

function fault(code, message) {
  return new RemoteError(`btw/${code}`, message)
}

function newest(record) {
  return record.turns.at(-1)
}

function publicTurn({ modelReply, submissionId, ...fields }) {
  return fields
}

function toDetailShape({ route, snapshot, turns, ...publicFields }) {
  return { ...publicFields, turns: turns.map(publicTurn) }
}

function toDetail(record) {
  return parseDetail(toDetailShape(record))
}

function toSummary({ id, sessionId, question, createdAt, updatedAt, version, turns }) {
  return { id, sessionId, question, createdAt, updatedAt, version, status: turns.at(-1).status }
}

function nextRevision(record, turns, time = Date.now()) {
  return { ...record, turns, updatedAt: Math.max(time, record.updatedAt), version: record.version + 1 }
}

function nextTurn(question, createdAt) {
  return { question, reply: '', status: 'generating', createdAt }
}

function withLatest(record, turn, time) {
  return nextRevision(record, [...record.turns.slice(0, -1), turn], time)
}

function isDone(record) {
  return newest(record).status !== 'generating'
}

// A side request can start while the main loop is executing tools. Only a fully
// answered tool batch belongs to the frozen prefix. Leave that pending tail in
// the main loop and retain every preceding committed block unchanged.
function completeToolBoundary(messages) {
  let complete = 0
  const pending = new Set()
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      if (pending.size) break
      for (const block of message.content) {
        if (block.type === 'tool-call') pending.add(block.id)
      }
    } else if (message.role === 'tool') {
      if (!pending.delete(message.toolCallId)) break
    } else if (message.role === 'user' && pending.size) {
      break
    }
    if (!pending.size) complete = index + 1
  }
  return complete
}

function sameRoute(left, right) {
  return left?.provider === right.provider && left.model === right.model
}

function freezeSnapshot(session, selected, observed, tokenMeter) {
  const derived = session.deriveMessages()
  const end = completeToolBoundary(derived)
  const matchesSurface = observed?.request.messages.length === end &&
    observed.request.messages.every((message, index) => message === derived[index])
  const exact = matchesSurface && sameRoute(observed.request, selected) ? observed : undefined
  const header = session.requestHeader?.()
  const matchingHeader = sameRoute(header?.config, selected) ? header : undefined
  const controls = exact?.request ?? matchingHeader?.config ?? selected
  const usesAdapterDefault = exact ? exact.usesAdapterDefault : matchingHeader?.adapterDefaults?.maxTokens
  const maxTokens = usesAdapterDefault ? undefined : controls.maxTokens
  const route = { ...selected, reasoningEffort: selected.reasoningEffort ?? controls.reasoningEffort }
  const messages = exact?.request.messages ?? derived.slice(0, end)
  const tools = exact ? exact.request.tools : header?.tools
  let toolHistory = exact ? exact.request.toolHistory : session.toolHistory?.()
  if (!exact && toolHistory && end < derived.length) {
    const messageIds = new Set(messages.map(message => message.id))
    toolHistory = { ...toolHistory, updates: toolHistory.updates.filter(update => messageIds.has(update.messageId)) }
  }
  let measuredPrefix
  if (end === derived.length && tokenMeter) {
    const { temperature, stop, maxTokens } = controls
    const envelope = { config: { ...route, temperature, stop, maxTokens }, ...(tools && { tools }) }
    try { measuredPrefix = tokenMeter.measure(session, envelope).totalTokens } catch { /* Estimate below. */ }
  }
  // Persist only lossless-JSON model inputs; the session identity, call signal,
  // caller, and prepared dispatch belong exclusively to the original request.
  const snapshot = JSON.parse(JSON.stringify({
    mode: 'native',
    anchor: exact?.anchor ?? (end === derived.length ? session.surface?.nodes?.at(-1) ?? null : null),
    messages,
    system: exact?.request.system,
    tools,
    toolHistory,
    temperature: controls.temperature,
    maxTokens,
    stop: controls.stop,
    measuredPrefix: Number.isSafeInteger(measuredPrefix) && measuredPrefix >= 0 ? measuredPrefix : undefined,
  }))
  return { route, snapshot }
}

function userInput(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function assistantInput(id, text, route) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: route.provider, model: route.model },
  }
}

function questionInput(question) {
  return userInput(`${NO_TOOLS}\n\nQuestion:\n${question}`)
}

function requestMessages(record, includeSettledLastReply = false) {
  const { snapshot } = record
  const messages = [...snapshot.messages]
  for (const [index, turn] of record.turns.entries()) {
    messages.push(questionInput(turn.question))
    if (index === record.turns.length - 1 && !includeSettledLastReply) break
    // Native history includes user input and committed assistant messages.
    // Failed provider attempts and recovered checkpoints are UI history only.
    if (turn.modelReply) messages.push(turn.modelReply)
    else if (turn.status === 'completed' && turn.reply.trim()) {
      messages.push(assistantInput(`${record.id}/reply/${index + 1}`, turn.reply, record.route))
    }
  }
  return messages
}

function requestFields(snapshot) {
  const { system, tools, toolHistory, temperature, maxTokens, stop } = snapshot
  return {
    ...(system !== undefined && { system }), ...(tools !== undefined && { tools }),
    ...(toolHistory !== undefined && { toolHistory }), ...(temperature !== undefined && { temperature }),
    ...(maxTokens !== undefined && { maxTokens }), ...(stop !== undefined && { stop }),
  }
}

function responsesRegistration(llm, { provider, model }) {
  // DSH 0.2.2-rc.5 exposes no transport-only cache hint. Qualify the exact
  // registered adapter and model before using its internal prepared dispatch.
  if (typeof llm.registration !== 'function' || typeof llm.normalizeModelInfo !== 'function' ||
      typeof llm.resolveCallWithInfo !== 'function' || typeof llm.streamWithRegistration !== 'function') return
  try {
    const registration = llm.registration(provider)
    const { adapter } = registration
    if (Object.getPrototypeOf(adapter) !== PiAiAdapter.prototype) return
    const descriptor = adapter.modelOf(adapter.current(), provider, model)
    if (descriptor.api === 'openai-responses' && descriptor.compat?.promptCacheKeyMode !== 'disabled') return registration
  } catch {
    // Let the ordinary runtime report errors for unknown routes and models.
  }
}

async function* streamSideQuestion(llm, options, record) {
  const registration = responsesRegistration(llm, options)
  if (!registration) {
    yield* llm.stream(options)
    return
  }

  // The stock Pi adapter captures the same model snapshot synchronously at
  // prepareCall entry. Late-bind the session ID only to this pinned adapter
  // dispatch. Generic llm/stream listeners must keep seeing the side request
  // without an ID, including listeners that flush or mutate a main session.
  const { provider, model, reasoningEffort, temperature, maxTokens, stop, signal } = options
  const prepared = await registration.adapter.prepareCall(provider, model, signal)
  const modelInfo = llm.normalizeModelInfo(registration, model, prepared.model)
  const { config } = llm.resolveCallWithInfo({ provider, model, reasoningEffort, temperature, maxTokens, stop }, modelInfo)
  yield* llm.streamWithRegistration({ ...options, ...config }, {
    registration, config, modelInfo,
    dispatch: request => prepared.stream({ ...request, sessionId: record.sessionId }),
  })
}

function modelReplyFor(record, assembler, interrupted) {
  const received = interrupted ? assembler.interruptedBlocks() : assembler.blocks()
  const content = received.filter(block => block.type === 'text' || block.type === 'reasoning')
  if (!content.length) return undefined
  const replayState = interrupted || content.length !== received.length ? undefined : assembler.replayState
  return {
    ...assistantInput(`${record.id}/reply/${record.turns.length}`, '', record.route), content,
    ...(replayState !== undefined && { source: { kind: 'model', provider: record.route.provider, model: record.route.model, replayState } }),
  }
}

function readUsage(usage) {
  const counts = {}
  for (const key of TOKEN_FIELDS) {
    const count = usage?.[key]
    if (Number.isSafeInteger(count) && count >= 0) counts[key] = count
  }
  return Object.keys(counts).length > 0 ? counts : undefined
}

function replyDelta(previousText, turn) {
  const offset = previousText !== undefined && turn.reply.startsWith(previousText) ? previousText.length : 0
  const { status, finishedAt, error, saveError, usage, timing } = publicTurn(turn)
  return {
    offset, text: turn.reply.slice(offset), status,
    ...(finishedAt !== undefined && { finishedAt }), ...(error !== undefined && { error }),
    ...(saveError !== undefined && { saveError }), ...(usage !== undefined && { usage }),
    ...(timing !== undefined && { timing }),
  }
}

// Coalesce UI wakeups: each watcher reads the newest immutable revision, so a slow
// browser does not accumulate a queue of full answers. There is no async gap between
// checking the version and subscribing to the next pulse.
function waitForPulse(listeners, id, signal) {
  signal.throwIfAborted()
  return new Promise((resolvePulse, rejectPulse) => {
    const current = listeners.get(id) ?? new Set()
    listeners.set(id, current)
    function cleanup() {
      current.delete(wake)
      if (current.size === 0) listeners.delete(id)
      signal.removeEventListener('abort', onAbort)
    }
    function wake() {
      cleanup()
      resolvePulse()
    }
    function onAbort() {
      cleanup()
      rejectPulse(signal.reason)
    }
    current.add(wake)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class BtwHost {
  constructor({ store, llm, logger, tokenMeter }) {
    this.store = store
    this.llm = llm
    this.logger = logger
    this.tokenMeter = tokenMeter
    this.mainRequests = new WeakMap()
    this.runs = new Map()
    this.listeners = new Map()
    this.sessions = new Map()
    this.opening = new Set()
    this.running = new Set()
    this.admissions = new Set()
    this.archiveRetries = new Set()
    this.lifetime = new AbortController()
  }

  async prepare(sessionId, signal, owner) {
    signal?.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    let state = this.sessions.get(sessionId)
    if (state && owner && state.owner !== owner) {
      this.retire(sessionId, state.owner)
      state = undefined
    }
    if (!state) {
      state = { owner, controller: new AbortController(), records: new Map(), terminalWrites: new Map() }
      // AgentLoop disposes the agent scope before closing the session write handle.
      state.disposeOwner = owner?.ctx?.effect(() => () => {
        state.disposeOwner = undefined
        if (this.sessions.get(sessionId) === state) this.retire(sessionId, owner)
      }, 'btw.archiveOwner')
      this.sessions.set(sessionId, state)
      const opening = this.openSession(sessionId, state).finally(() => {
        this.opening.delete(opening)
        state.opening = undefined
        if (!state.archive && this.sessions.get(sessionId) === state) {
          this.sessions.delete(sessionId)
          return state.disposeOwner?.()
        }
      })
      state.opening = opening
      this.opening.add(opening)
    }
    await state.opening
    signal?.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    state.controller.signal.throwIfAborted()
    return !!state.archive
  }

  retire(sessionId, owner) {
    const state = this.sessions.get(sessionId)
    if (!state || state.owner !== owner) return
    this.sessions.delete(sessionId)
    state.controller.abort()
    for (const id of state.records.keys()) this.notify(id)
    return state.disposeOwner?.()
  }

  async openSession(sessionId, state) {
    const signal = AbortSignal.any([state.controller.signal, this.lifetime.signal])
    const archive = await this.store.open(sessionId, signal)
    if (!archive) return
    signal.throwIfAborted()
    state.archive = archive
    for (const record of archive.records) {
      this.publish(record, false, state)
      if (isDone(record)) continue
      const time = Math.max(Date.now(), record.updatedAt)
      const terminal = withLatest(record, {
        ...newest(record), status: 'interrupted', finishedAt: time, error: INTERRUPTION,
      }, time)
      this.publish(terminal, false, state)
      try {
        await this.save(terminal, state)
      } catch {
        if (state.controller.signal.aborted) break
        this.logger?.error('BTW could not save a recovered reply')
        this.retryTerminalSave(terminal, state)
      }
    }
  }

  observeMain(session, request) {
    const header = session.requestHeader?.()
    const usesAdapterDefault = sameRoute(header?.config, request) &&
      header.config.maxTokens === request.maxTokens && header.adapterDefaults?.maxTokens === true
    const anchor = session.surface?.nodes?.at(-1) ?? null
    this.mainRequests.set(session, { request, anchor, usesAdapterDefault })
  }

  async save(record, state) {
    state.controller.signal.throwIfAborted()
    const turns = record.turns.map(({ saveError, ...turn }) => turn)
    await state.archive.put(threadSchema.parse({ ...record, turns }), state.controller.signal)
  }

  retryTerminalSave(terminal, state) {
    const time = terminal.updatedAt
    const failed = withLatest(terminal, { ...newest(terminal), saveError: ARCHIVE_ERROR }, time)
    const recovered = withLatest(failed, newest(terminal), time)
    this.publish(failed, true, state)
    const signal = AbortSignal.any([state.controller.signal, this.lifetime.signal])
    const retry = (async () => {
      while (!signal.aborted && state.records.get(failed.id) === failed) {
        try { await delay(CHECKPOINT_INTERVAL_MS, undefined, { signal, ref: false }) }
        catch { return }
        if (state.records.get(failed.id) !== failed) return
        if (this.runs.get(failed.id)?.state === state) continue
        const write = this.save(recovered, state)
        state.terminalWrites.set(failed.id, write)
        try {
          await write
          if (this.runs.get(failed.id)?.state !== state) {
            this.publish(recovered, true, state)
            return
          }
        } catch {
          // Keep the latest answer eligible for the next archive check.
        } finally {
          state.terminalWrites.delete(failed.id)
        }
      }
    })()
    this.archiveRetries.add(retry)
    retry.then(() => this.archiveRetries.delete(retry), () => this.archiveRetries.delete(retry))
  }

  read(sessionId, id) {
    parseThreadId(id)
    const record = this.sessions.get(sessionId)?.records.get(id)
    if (!record) throw fault('not-found', '找不到这条侧问。')
    return record
  }

  list(sessionId) {
    return [...(this.sessions.get(sessionId)?.records.values() ?? [])]
      .map(toSummary)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
  }

  get(sessionId, id) {
    return toDetail(this.read(sessionId, id))
  }

  async contextWindow(sessionId, id, requestSignal) {
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, this.lifetime.signal])
      : this.lifetime.signal
    signal.throwIfAborted()
    const { provider, model } = this.read(sessionId, id).route
    let capacity
    try {
      const info = await this.llm.resolveModelInfo(provider, model, signal)
      capacity = info.context?.contextWindow
    } catch {
      // A disconnected provider cannot supply the optional context meter.
    }
    signal.throwIfAborted()
    if (!Number.isSafeInteger(capacity) || capacity <= 0) return { contextWindow: null }
    const record = this.read(sessionId, id)
    const price = messages => messages.reduce((sum, message) => sum + estimateMessage(message), 0)
    const snapshot = record.snapshot
    const schemaTokens = estimateToolsTokens({ tools: snapshot.tools })
    const systemTokens = snapshot.system
      ? estimateMessage({ role: 'system', content: [{ type: 'text', text: snapshot.system }] }) : 0
    const overhead = schemaTokens + systemTokens
    const fullEstimate = price(requestMessages(record, true)) + overhead
    const promptFields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    const anchor = record.turns.findIndex(({ usage }) => promptFields.some(field => usage?.[field] !== undefined))
    const nativeAdjustment = snapshot.measuredPrefix !== undefined
      ? snapshot.measuredPrefix - (price(snapshot.messages) + overhead) : 0
    let usageAdjustment = 0
    if (anchor !== -1) {
      const reported = promptFields.reduce((sum, field) => sum + (record.turns[anchor].usage[field] ?? 0), 0)
      const promptEstimate = price(requestMessages({ ...record, turns: record.turns.slice(0, anchor + 1) })) + overhead
      usageAdjustment = reported - promptEstimate
    }
    // Fixed native measurements and assistant-context deltas coexist with the
    // first side-request sample. Newer billing reports do not reset the meter.
    return { contextWindow: capacity, estimatedTokens: fullEstimate + Math.max(0, nativeAdjustment, usageAdjustment) }
  }

  async create(agent, question, signal) {
    parseQuestion(question)
    const sessionId = parseSessionId(agent.session.id)
    if (!await this.prepare(sessionId, signal, agent)) {
      throw fault('session-not-saved', '请先发送一条消息开始侧问')
    }
    const selected = agent.model.current()
    const model = routeSchema.safeParse(selected && {
      provider: selected.provider,
      model: selected.model,
      reasoningEffort: selected.reasoningEffort,
    })
    if (!model.success) throw fault('model-unavailable', '当前会话未配置可用模型。')
    const time = Date.now()
    const { route, snapshot } = freezeSnapshot(agent.session, model.data, this.mainRequests.get(agent.session), this.tokenMeter)
    return this.admit({
      id: `btw-${randomUUID()}`, sessionId, question, createdAt: time, updatedAt: time, version: 1,
      turns: [nextTurn(question, time)], route, snapshot,
    })
  }

  followup(sessionId, id, question, signal, submissionId) {
    signal?.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    parseQuestion(question)
    const record = this.read(sessionId, id)
    const active = this.runs.get(id)
    const state = this.sessions.get(sessionId)
    const receipt = (admitted, turnIndex) => {
      const { usage, ...turn } = publicTurn(admitted.turns[turnIndex])
      return { id, sessionId, updatedAt: admitted.updatedAt, version: admitted.version, turnIndex, turn }
    }
    if (submissionId !== undefined) {
      parseSubmissionId(submissionId)
      const turnIndex = record.turns.findIndex(turn => turn.submissionId === submissionId)
      if (turnIndex !== -1) {
        if (record.turns[turnIndex].question !== question) throw fault('submission-mismatch', '侧问提交内容不一致。')
        return Promise.resolve(receipt(record, turnIndex))
      }
      if (active?.state === state && active.submission?.submissionId === submissionId) {
        if (active.submission.question !== question) throw fault('submission-mismatch', '侧问提交内容不一致。')
        return active.admission
      }
    }
    if (active?.state === state || !isDone(record)) throw fault('generating', '上一条回复仍在生成。')
    if (newest(record).error === CONTEXT_OVERFLOW) throw fault('context-overflow', '已达上下文上限。')
    const time = Math.max(Date.now(), record.updatedAt)
    const turns = record.turns.map(({ saveError, ...turn }) => turn)
    const turn = nextTurn(question, time)
    if (submissionId !== undefined) turn.submissionId = submissionId
    return this.admit(nextRevision(record, [...turns, turn], time), admitted => receipt(admitted, turns.length))
  }

  admit(record, result = toDetail) {
    const controller = new AbortController()
    const state = this.sessions.get(record.sessionId)
    const run = { controller, state, submission: newest(record) }
    this.runs.set(record.id, run)
    const admission = Promise.resolve(state.terminalWrites.get(record.id)).catch(() => {}).then(() => this.save(record, state)).then(() => {
      state.controller.signal.throwIfAborted()
      this.publish(record, true, state)
      // Start only after durable admission. No caller/transport signal is inherited.
      const generation = this.generate(record, controller.signal, () => {
        if (this.runs.get(record.id) === run) this.runs.delete(record.id)
      }, state)
      this.running.add(generation)
      generation.then(() => this.running.delete(generation), () => this.running.delete(generation))
      return result(record)
    }).catch(error => {
      if (this.runs.get(record.id) === run) this.runs.delete(record.id)
      this.logger?.error('BTW could not admit a question')
      throw fault('save-failed', '保存侧问失败。')
    })
    run.admission = admission
    this.admissions.add(admission)
    admission.then(() => this.admissions.delete(admission), () => this.admissions.delete(admission))
    return admission
  }

  publish(record, wake = true, state) {
    if (state.controller.signal.aborted) return
    state.records.set(record.id, record)
    if (wake) this.notify(record.id)
  }

  notify(id) {
    for (const listener of this.listeners.get(id) ?? []) listener()
  }

  async generate(record, runSignal, releaseRun, state) {
    const signal = AbortSignal.any([runSignal, this.lifetime.signal, state.controller.signal])
    const assembler = new BlockAssembler()
    let current = record
    let checkpointVersion = record.version
    let pendingSave
    let previewTimer
    let lastNotified = 0
    let finish
    let failureCode
    let firstTokenMs
    const checkpointTimer = setInterval(() => {
      if (pendingSave || checkpointVersion === current.version || signal.aborted) return
      const checkpoint = current
      pendingSave = this.save(checkpoint, state).then(() => {
        checkpointVersion = checkpoint.version
      }).catch(() => {
        this.logger?.error('BTW could not save a reply checkpoint')
      }).finally(() => { pendingSave = undefined })
    }, CHECKPOINT_INTERVAL_MS)
    const sendPreview = () => {
      previewTimer = undefined
      lastNotified = Date.now()
      this.notify(record.id)
    }
    const startedAt = performance.now()
    try {
      signal.throwIfAborted()
      for await (const chunk of streamSideQuestion(this.llm, {
        ...record.route,
        ...requestFields(record.snapshot),
        messages: requestMessages(record),
        purpose: 'btw',
        signal,
      }, record)) {
        signal.throwIfAborted()
        if (firstTokenMs === undefined && isTokenDelta(chunk)) {
          firstTokenMs = Math.round(performance.now() - startedAt)
        }
        assembler.push(chunk)
        if (chunk.type === 'finish') {
          finish = chunk.reason.kind
          if (finish === 'error') failureCode = chunk.reason.failure?.code
          break
        }
        if (chunk.type !== 'text-delta' && !(chunk.type === 'block-end' && chunk.block.type === 'text')) continue
        const reply = assembler.interruptedBlocks().filter(block => block.type === 'text').map(block => block.text).join('')
        const time = Date.now()
        current = withLatest(current, { ...newest(current), reply }, time)
        this.publish(current, false, state)
        if (time - lastNotified >= PREVIEW_INTERVAL_MS) {
          clearTimeout(previewTimer)
          sendPreview()
        } else if (previewTimer === undefined) {
          previewTimer = setTimeout(sendPreview, PREVIEW_INTERVAL_MS - (time - lastNotified))
        }
      }
    } catch (error) {
      // Only the canonical overflow code crosses the wire, never provider details.
      failureCode = error?.code
    }
    clearInterval(checkpointTimer)
    clearTimeout(previewTimer)
    const timing = { requestMs: Math.round(performance.now() - startedAt),
      ...(firstTokenMs !== undefined && { firstTokenMs }) }
    await pendingSave
    if (state.controller.signal.aborted) {
      releaseRun()
      return
    }
    const time = Math.max(Date.now(), current.updatedAt)
    const turn = newest(current)
    const interrupted = signal.aborted || finish === 'aborted'
    let error
    if (interrupted) error = INTERRUPTION
    else if (failureCode === CONTEXT_WINDOW_EXCEEDED_CODE) error = CONTEXT_OVERFLOW
    else if (!finish || finish === 'error') error = FAILURE
    else if (!turn.reply.trim()) error = NO_TEXT
    let modelReply
    if (signal.aborted || !error) {
      try { modelReply = modelReplyFor(record, assembler, signal.aborted) } catch { error = FAILURE }
    }
    const usage = readUsage(assembler.usage)
    const terminal = withLatest(current, {
      ...turn,
      status: interrupted ? 'interrupted' : error ? 'failed' : 'completed',
      finishedAt: time,
      ...(error ? { error } : {}),
      ...(modelReply ? { modelReply } : {}),
      ...(usage ? { usage } : {}),
      timing,
    }, time)
    try {
      await this.save(terminal, state)
      releaseRun()
      this.publish(terminal, true, state)
    } catch {
      this.logger?.error('BTW could not save a terminal reply')
      releaseRun()
      if (!state.controller.signal.aborted) this.retryTerminalSave(terminal, state)
    }
  }

  async *watch(sessionId, id, version, assertAccess, requestSignal) {
    if (version != null) parseVersion(version)
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, this.lifetime.signal])
      : this.lifetime.signal
    while (!signal.aborted) {
      assertAccess()
      const record = this.read(sessionId, id)
      if (record.version !== version) {
        version = record.version
        yield toDetail(record)
      }
      if (isDone(record) && !record.turns[0].saveError) return
      // If a revision arrived while the generator was yielding, reread promptly.
      if (this.read(sessionId, id).version !== version) continue
      try {
        await waitForPulse(this.listeners, id, signal)
      } catch (error) {
        if (signal.aborted) return
        throw error
      }
    }
  }

  async *watchThread(sessionId, id, assertAccess, requestSignal) {
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, this.lifetime.signal])
      : this.lifetime.signal
    let previous
    while (!signal.aborted) {
      assertAccess()
      const record = this.read(sessionId, id)
      if (!previous) {
        previous = record
        yield { kind: 'snapshot', detail: toDetail(record) }
        continue
      }
      if (record.version !== previous.version) {
        const firstTurn = previous.turns.length
        const oldTurn = newest(previous)
        const updatedTurn = record.turns[firstTurn - 1]
        const reply = !isDone(previous) || oldTurn.saveError !== updatedTurn.saveError
          ? replyDelta(oldTurn.reply, updatedTurn) : undefined
        previous = record
        yield {
          kind: 'change', version: record.version, updatedAt: record.updatedAt, firstTurn,
          turns: record.turns.slice(firstTurn).map(publicTurn), ...(reply && { reply }),
        }
        continue
      }
      try {
        await waitForPulse(this.listeners, id, signal)
      } catch (error) {
        if (signal.aborted) return
        throw error
      }
    }
  }

  async *watchReply(sessionId, id, turnIndex, version, assertAccess, requestSignal) {
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, this.lifetime.signal])
      : this.lifetime.signal
    let previousText
    while (!signal.aborted) {
      assertAccess()
      const record = this.read(sessionId, id)
      const turn = record.turns[turnIndex]
      if (!turn) throw fault('not-found', '找不到这轮侧问。')
      if (record.version !== version || turn.status !== 'generating') {
        // A changed baseline may have reordered text blocks before we began watching.
        const delta = replyDelta(previousText, turn)
        version = record.version
        previousText = turn.reply
        yield { version, updatedAt: record.updatedAt, ...delta }
      } else if (previousText === undefined) {
        previousText = turn.reply
      }
      if (turn.status !== 'generating') return
      if (this.read(sessionId, id).version !== version) continue
      try {
        await waitForPulse(this.listeners, id, signal)
      } catch (error) {
        if (signal.aborted) return
        throw error
      }
    }
  }

  async close() {
    this.lifetime.abort()
    await Promise.allSettled([...this.admissions])
    await Promise.allSettled([...this.running])
    await Promise.allSettled([...this.opening.values()])
    await Promise.allSettled([...this.archiveRetries])
    await Promise.allSettled([...this.sessions].map(([id, state]) => this.retire(id, state.owner)))
  }
}

export default class BtwService extends TypertRemoteService {
  static inject = inject

  constructor(ctx) {
    super(ctx, 'btw')
  }

  async [Service.init]() {
    const store = sessionThreadStore(this.ctx.sessionPersistence, record => threadSchema.parse(record), (file, reason) => {
      this.ctx.logger?.warn('BTW ignored archive %s: %s', file, reason)
    })
    const host = new BtwHost({ store, llm: this.ctx.llm, logger: this.ctx.logger })
    this.ctx.effect(() => () => host.close(), 'btw.close')
    this.ctx.on('agent/disposed', ({ agent }) => host.retire(agent.session.id, agent))
    this.ctx.on('llm/stream', (request, next) => {
      if (isAgentLoopRequest(request) && request.sessionId) {
        const session = this.ctx.agents.get(request.sessionId)?.session
        if (session) host.observeMain(session, request)
      }
      return next()
    })
    this.ctx.inject(['tokenMeter'], scope => {
      host.tokenMeter = scope.tokenMeter
      scope.effect(() => () => { host.tokenMeter = undefined }, 'btw.tokenMeter')
    })
    this.host = host
    // The loader snapshots ./typert once per process. Register this hand-written
    // contribution with the live plugin so an installed update exposes it immediately.
    this.ctx.typert.register({
      package: `${PACKAGE_NAME}-meter`, face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] }, invocations: [contextDescriptor, threadDescriptor, submitFollowupDescriptor],
    })
  }

  sessionFor(agent) {
    const peer = this.ctx.invocation?.peer
    if (peer?.principal.kind !== 'owner' || peer.signal.aborted) throw fault('denied', '无权访问侧问。')
    const sessionId = parseSessionId(agent?.session?.id)
    if (this.ctx.agents.get(sessionId) !== agent) throw fault('denied', '当前会话不可用。')
    return sessionId
  }

  async prepare(agent, signal) {
    const sessionId = this.sessionFor(agent)
    const available = await this.host.prepare(sessionId, signal, agent)
    this.sessionFor(agent)
    return { sessionId, available }
  }

  async create(agent, question, signal) {
    const { available } = await this.prepare(agent, signal)
    if (!available) throw fault('session-not-saved', '请先发送一条消息开始侧问')
    return this.host.create(agent, question, signal)
  }

  async list(agent, signal) {
    const { sessionId } = await this.prepare(agent, signal)
    return this.host.list(sessionId)
  }

  async get(agent, id, signal) {
    const { sessionId } = await this.prepare(agent, signal)
    return this.host.get(sessionId, id)
  }

  async contextCapacity(agent, id, signal) {
    const { sessionId } = await this.prepare(agent, signal)
    return this.host.contextWindow(sessionId, id, signal)
  }

  async followup(agent, id, question, signal) {
    const { sessionId } = await this.prepare(agent, signal)
    return this.host.followup(sessionId, id, question, signal)
  }

  async submitFollowup(agent, id, question, submissionId, signal) {
    const { sessionId } = await this.prepare(agent, signal)
    return this.host.followup(sessionId, id, question, signal, submissionId)
  }

  async *watch(agent, id, version, signal) {
    const { sessionId } = await this.prepare(agent, signal)
    yield* this.host.watch(sessionId, id, version, () => this.sessionFor(agent), signal)
  }

  async *watchThread(agent, id, signal) {
    const { sessionId } = await this.prepare(agent, signal)
    yield* this.host.watchThread(sessionId, id, () => this.sessionFor(agent), signal)
  }

  async *watchReply(agent, id, turnIndex, version, signal) {
    const { sessionId } = await this.prepare(agent, signal)
    yield* this.host.watchReply(sessionId, id, turnIndex, version, () => this.sessionFor(agent), signal)
  }
}
