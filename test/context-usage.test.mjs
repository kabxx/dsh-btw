import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { BtwHost, threadSchema } from '../src/host/index.js'

const { estimateMessage } = createRequire(process.env.DSH_INSTALL_DIR
  ? resolve(process.env.DSH_INSTALL_DIR, 'package.json') : import.meta.url)('@deepseek-ai/dsh-token-meter/estimate')

const sessionId = 'context-meter-session'
const id = 'btw-12345678-1234-1234-1234-123456789012'
const firstQuestion = 'first question'
const firstTurn = {
  question: firstQuestion, reply: 'first answer', status: 'completed', createdAt: 1, finishedAt: 2,
  usage: { inputTokens: 400, outputTokens: 5 },
}

async function readContext(turns, measuredPrefix) {
  const record = threadSchema.parse({
    id, sessionId, question: firstQuestion, createdAt: 1, updatedAt: 8, version: 1,
    route: { provider: 'fixture-provider', model: 'fixture-model' },
    snapshot: {
      mode: 'native', anchor: null, measuredPrefix,
      messages: [{ id: 'main-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'frozen reference' }] }],
    },
    turns,
  })
  const host = new BtwHost({
    store: { async open() { return { records: [record] } } },
    llm: { async resolveModelInfo() { return { context: { contextWindow: 1_500 } } } },
  })
  try {
    await host.prepare(sessionId)
    return await host.contextWindow(sessionId, id)
  } finally {
    await host.close()
  }
}

const secondTurn = {
  question: 'next question', reply: 'newly committed answer', status: 'completed', createdAt: 3, finishedAt: 4,
  usage: { inputTokens: 850, cacheReadTokens: 440, cacheWriteTokens: 60, outputTokens: 20, totalTokens: 1_370 },
}

const failedTurn = {
  question: 'failed question', reply: 'this partial reply does not enter the next request',
  status: 'failed', createdAt: 5, finishedAt: 6,
}

test('context meter uses the latest reported prompt and prices its committed reply', async () => {
  const replyTokens = estimateMessage({ role: 'assistant', content: [{ type: 'text', text: secondTurn.reply }] })
  const expected = { contextWindow: 1_500, estimatedTokens: 1_350 + replyTokens }
  assert.deepEqual(await readContext([firstTurn, secondTurn]), expected)
  assert.deepEqual(await readContext([firstTurn, secondTurn], 1_600), expected)
})

test('context meter skips usage without prompt fields and excludes failed reply text', async () => {
  const completed = await readContext([firstTurn, secondTurn])
  const failed = { ...failedTurn, usage: { outputTokens: 50, totalTokens: 2_000 } }
  const missingPrompt = await readContext([firstTurn, secondTurn, failed])
  assert.ok(missingPrompt.estimatedTokens > completed.estimatedTokens, 'the later question is in the next request')
  assert.deepEqual(missingPrompt, await readContext([firstTurn, secondTurn, { ...failed, reply: '' }]))
  assert.deepEqual(await readContext([
    firstTurn, secondTurn, { ...failed, usage: { inputTokens: 1_420, outputTokens: 50 } },
  ]), { contextWindow: 1_500, estimatedTokens: 1_420 }, 'a failed attempt can still report usable prompt data')
})

test('context meter keeps the last usable prompt after failed zero usage', async () => {
  const withoutPrompt = await readContext([firstTurn, secondTurn, failedTurn])
  const failedWithZeroPrompt = {
    ...failedTurn,
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  }
  assert.deepEqual(await readContext([firstTurn, secondTurn, failedWithZeroPrompt]), withoutPrompt)

  const firstFailure = { ...failedWithZeroPrompt, question: firstQuestion, createdAt: 1 }
  assert.deepEqual(
    await readContext([firstFailure], 700),
    await readContext([{ ...firstFailure, usage: undefined }], 700),
  )
})

test('context meter uses the frozen estimate before a provider prompt is reported', async () => {
  const turns = [{ ...firstTurn, usage: undefined }]
  const estimated = await readContext(turns)
  const measured = await readContext(turns, 700)
  assert.ok(estimated.estimatedTokens > 0)
  assert.ok(estimated.estimatedTokens < 700)
  assert.ok(measured.estimatedTokens > 700, 'the frozen main measurement includes subsequent side messages')
})
