export const PACKAGE_NAME = '@kabxx/dsh-btw'
export const CONTEXT_OVERFLOW = 'context-window-exceeded'
const STATUSES = new Set(['generating', 'completed', 'failed', 'interrupted'])
export const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
const THREAD_ID = /^btw-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u

function checked(value, condition, field) {
  if (!condition) throw new TypeError(`Invalid BTW ${field}`)
  return value
}

export function parseSessionId(value) {
  return checked(value, typeof value === 'string' && value.length > 0, 'sessionId')
}

export function parseThreadId(value) {
  return checked(value, typeof value === 'string' && THREAD_ID.test(value), 'id')
}

export function parseQuestion(value) {
  return checked(value, typeof value === 'string' && value.trim() !== '', 'question')
}

export function parseVersion(value) {
  return checked(value, Number.isSafeInteger(value) && value >= 1, 'version')
}

function timestamp(value) {
  return checked(value, Number.isSafeInteger(value) && value >= 0, 'timestamp')
}

function object(value, fields) {
  return checked(value, value !== null && typeof value === 'object' && !Array.isArray(value)
    && [null, Object.prototype].includes(Object.getPrototypeOf(value))
    && Object.keys(value).every(key => fields.includes(key)), 'record shape')
}

function common(value) {
  return {
    id: parseThreadId(value.id),
    sessionId: parseSessionId(value.sessionId),
    question: parseQuestion(value.question),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    version: parseVersion(value.version),
  }
}

const commonFields = ['id', 'sessionId', 'question', 'createdAt', 'updatedAt', 'version']

function status(value) {
  return checked(value, STATUSES.has(value), 'status')
}

function parseUsage(usage) {
  object(usage, TOKEN_FIELDS)
  return Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, parsePosition(value)]))
}

function parseTiming(value) {
  object(value, ['requestMs', 'firstTokenMs'])
  const requestMs = timestamp(value.requestMs)
  if (value.firstTokenMs === undefined) return { requestMs }
  const firstTokenMs = timestamp(value.firstTokenMs)
  return checked({ requestMs, firstTokenMs }, firstTokenMs <= requestMs, 'first token timing')
}

export function parseTurn(value) {
  object(value, ['question', 'reply', 'status', 'createdAt', 'finishedAt', 'error', 'saveError', 'usage', 'timing'])
  const turn = {
    question: parseQuestion(value.question),
    reply: checked(value.reply, typeof value.reply === 'string', 'reply'),
    status: status(value.status),
    createdAt: timestamp(value.createdAt),
  }
  if (turn.status !== 'generating') turn.finishedAt = timestamp(value.finishedAt)
  else checked(value.finishedAt, value.finishedAt === undefined, 'finishedAt')
  if (value.error !== undefined) turn.error = checked(value.error, typeof value.error === 'string', 'error')
  if (value.saveError !== undefined) turn.saveError = checked(value.saveError, typeof value.saveError === 'string', 'saveError')
  if (value.usage !== undefined) turn.usage = parseUsage(value.usage)
  if (value.timing !== undefined) turn.timing = parseTiming(value.timing)
  return turn
}

export function parseDetail(value) {
  object(value, [...commonFields, 'turns'])
  checked(value.turns, Array.isArray(value.turns) && value.turns.length > 0, 'turns')
  return { ...common(value), turns: value.turns.map(parseTurn) }
}

function parseContext(value) {
  object(value, ['contextWindow', 'estimatedTokens'])
  const capacity = value.contextWindow
  const contextWindow = checked(capacity, capacity === null || (Number.isSafeInteger(capacity) && capacity > 0), 'contextWindow')
  return { contextWindow,
    ...(value.estimatedTokens !== undefined && { estimatedTokens: parsePosition(value.estimatedTokens) }),
  }
}

function parseSummaries(values) {
  checked(values, Array.isArray(values), 'summaries')
  return values.map(value => {
    object(value, [...commonFields, 'status'])
    return { ...common(value), status: status(value.status) }
  })
}

function codec(typeSymbol, parse) {
  return Object.freeze({ mode: 'strict', typeSymbol, create: () => ({ parse }) })
}

function parsePosition(value) {
  return checked(value, Number.isSafeInteger(value) && value >= 0, 'position')
}

export function appendTurn(detail, receipt) {
  if (detail.id !== receipt.id || detail.sessionId !== receipt.sessionId
    || receipt.turnIndex !== detail.turns.length || receipt.version <= detail.version) return detail
  return { ...detail, updatedAt: receipt.updatedAt, version: receipt.version, turns: [...detail.turns, receipt.turn] }
}

export function applyReply(detail, turnIndex, update) {
  const turn = detail.turns[turnIndex]
  if (!turn || turn.status !== 'generating' || update.version <= detail.version) return detail
  checked(update.offset <= turn.reply.length, 'reply offset')
  const turns = [...detail.turns]
  turns[turnIndex] = {
    ...turn, reply: turn.reply.slice(0, update.offset) + update.text, status: update.status,
    ...(update.finishedAt !== undefined && { finishedAt: update.finishedAt }),
    ...(update.error !== undefined && { error: update.error }),
    ...(update.saveError !== undefined && { saveError: update.saveError }),
    ...(update.usage !== undefined && { usage: update.usage }),
    ...(update.timing !== undefined && { timing: update.timing }),
  }
  return { ...detail, updatedAt: update.updatedAt, version: update.version, turns }
}

function parseReceipt(value) {
  object(value, ['id', 'sessionId', 'updatedAt', 'version', 'turnIndex', 'turn'])
  return {
    id: parseThreadId(value.id), sessionId: parseSessionId(value.sessionId), updatedAt: timestamp(value.updatedAt),
    version: parseVersion(value.version), turnIndex: parsePosition(value.turnIndex), turn: parseTurn(value.turn),
  }
}

function parseReplyUpdate(value) {
  object(value, ['version', 'updatedAt', 'offset', 'text', 'status', 'finishedAt', 'error', 'saveError', 'usage', 'timing'])
  const update = {
    version: parseVersion(value.version), updatedAt: timestamp(value.updatedAt), offset: parsePosition(value.offset),
    text: checked(value.text, typeof value.text === 'string', 'text'), status: status(value.status),
  }
  if (update.status !== 'generating') update.finishedAt = timestamp(value.finishedAt)
  else checked(value.finishedAt, value.finishedAt === undefined, 'finishedAt')
  if (value.error !== undefined) update.error = checked(value.error, typeof value.error === 'string', 'error')
  if (value.saveError !== undefined) update.saveError = checked(value.saveError, typeof value.saveError === 'string', 'saveError')
  if (value.usage !== undefined) update.usage = parseUsage(value.usage)
  if (value.timing !== undefined) update.timing = parseTiming(value.timing)
  return update
}

const detail = codec(`${PACKAGE_NAME}#Detail`, parseDetail)
const receipt = codec(`${PACKAGE_NAME}#FollowupReceipt`, parseReceipt)
const replyUpdate = codec(`${PACKAGE_NAME}#ReplyUpdate`, parseReplyUpdate)
const summaryList = codec(`${PACKAGE_NAME}#SummaryList`, parseSummaries)
const agent = Object.freeze({
  name: 'agent',
  wire: 'agentId',
  source: 'lookup',
  lookup: 'agent',
  codec: codec('@deepseek-ai/dsh-session/types#SessionId', parseSessionId),
})

function parameter(name, parse, acceptsUndefined) {
  return Object.freeze({
    name,
    wire: name,
    source: 'json',
    codec: codec(`${PACKAGE_NAME}#${name}`, parse),
    ...(acceptsUndefined ? { acceptsUndefined: true } : {}),
  })
}

const id = parameter('id', parseThreadId)
const question = parameter('question', parseQuestion)
const version = parameter('version', value => value == null ? undefined : parseVersion(value), true)

function descriptor(method, parameters, result, stream = false) {
  return Object.freeze({
    id: `${PACKAGE_NAME}#btw/${method}`,
    service: 'btw',
    namespace: 'btw',
    method,
    invocation: { kind: 'direct' },
    parameters: Object.freeze([agent, ...parameters]),
    cancellation: { parameter: 'signal' },
    result,
    ...(stream ? { mode: 'stream' } : {}),
  })
}

export const descriptors = Object.freeze([
  descriptor('create', [question], detail),
  descriptor('list', [], summaryList),
  descriptor('get', [id], detail),
  descriptor('followup', [id, question], receipt),
  descriptor('watch', [id, version], detail, true),
  descriptor('watchReply', [id, parameter('turnIndex', parsePosition), version], replyUpdate, true),
])

export const contextDescriptor = descriptor('contextCapacity', [id], codec(`${PACKAGE_NAME}#ContextWindow`, parseContext))
export const TYPERT_REMOTE = Object.freeze({ package: PACKAGE_NAME, descriptors: Object.freeze([...descriptors, contextDescriptor]) })
export const createBtwContribution = () => TYPERT_REMOTE
