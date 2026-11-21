import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inject, makeController, makeSource, mountClient, observeSpeech } from '../src/client/index.js'
import { applyThreadEvent, applyReply, parseSessionId, parseTurn } from '../src/shared/wire.js'
import { contextReading, createCompositionGuard, formatMessageTime, formatTokenCount, orderHistory, summarizeUsage } from '../src/client/views.js'
import zh from '../locale/zh.json' with { type: 'json' }
import en from '../locale/en.json' with { type: 'json' }

function snapshot(initial) {
  let current = initial
  const listeners = new Set()
  return {
    getSnapshot: () => current,
    set(next) { current = next; for (const listen of [...listeners]) listen() },
    subscribe(listen) { listeners.add(listen); return () => listeners.delete(listen) },
  }
}

function harness() {
  const mounted = snapshot('main')
  const files = { id: 'files', kind: 'files' }
  const old = { id: 'old-btw', kind: 'kabxx-btw' }
  const tabs = new Map([['main', [files, old]]])
  const inventory = () => [...tabs].flatMap(([sessionId, records]) => records.map(tab => ({
    sessionId, tabId: tab.id, kind: tab.kind, contentId: tab.kind,
  })))
  const openTabs = snapshot(inventory())
  const expanded = new Map()
  const activeKinds = new Map()
  const sidebarRight = {
    mounted, openTabs,
    tabsIn: id => tabs.get(id) ?? [],
    active: () => sidebarRight.tabsIn(mounted.getSnapshot()).find(tab => tab.kind === activeKinds.get(mounted.getSnapshot())),
    isExpanded: () => expanded.get(mounted.getSnapshot()) ?? false,
    toggleExpanded: () => expanded.set(mounted.getSnapshot(), !sidebarRight.isExpanded()),
    openTabIn(id, kind) {
      expanded.set(id, true)
      activeKinds.set(id, kind)
      if (sidebarRight.tabsIn(id).some(tab => tab.kind === kind)) return
      tabs.set(id, [...sidebarRight.tabsIn(id), { id: kind, kind }])
      openTabs.set(inventory())
    },
    closeIn(id, tabId) {
      tabs.set(id, sidebarRight.tabsIn(id).filter(tab => tab.id !== tabId))
      openTabs.set(inventory())
    },
  }
  const events = new Map()
  return {
    sidebarRight, mounted, files, remote: { btw: {} },
    on(event, listener) {
      const listeners = events.get(event) ?? new Set()
      events.set(event, listeners)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(event) { for (const listener of events.get(event) ?? []) listener() },
  }
}

test('usage follows the main chat cache buckets and keeps genuinely unknown usage absent', () => {
  const settled = usage => ({ status: 'completed', usage })
  assert.deepEqual(summarizeUsage([settled({ inputTokens: 100, outputTokens: 20 })]), {
    uncached: 100, cacheRead: 0, cacheWrite: 0, output: 20, total: 120, cacheRatio: 0,
  })
  assert.deepEqual(summarizeUsage([
    settled({ inputTokens: 100, outputTokens: 20 }),
    settled({ inputTokens: 80, cacheReadTokens: 50, cacheWriteTokens: 20, outputTokens: 10 }),
    { status: 'generating', usage: { inputTokens: 800, outputTokens: 2 } },
  ]), { uncached: 180, cacheRead: 50, cacheWrite: 20, output: 30, total: 280, cacheRatio: 0.2 })
  assert.deepEqual(summarizeUsage([settled(), settled({ totalTokens: 9 })]), {
    uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 9, cacheRatio: null,
  })
  assert.equal(summarizeUsage([settled()]).total, 0)
})

test('usage prefers each reported total and falls back to available buckets', () => {
  const reported = { status: 'completed', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 115 } }
  assert.deepEqual(summarizeUsage([reported]), {
    uncached: 10, cacheRead: 0, cacheWrite: 0, output: 5, total: 115, cacheRatio: 0,
  })
  assert.deepEqual(summarizeUsage([
    reported,
    { status: 'completed', usage: { inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 5, outputTokens: 3 } },
    { status: 'completed', usage: { totalTokens: 2 } },
    { status: 'generating', usage: { totalTokens: 1_000 } },
  ]), { uncached: 20, cacheRead: 5, cacheWrite: 5, output: 8, total: 140, cacheRatio: 5 / 30 })
})

test('a late Safari composition confirmation cannot submit the draft', () => {
  let time = 100;
  const guard = createCompositionGuard(() => time);
  const enter = { key: 'Enter', nativeEvent: { isComposing: false } };
  guard.start();
  assert.ok(guard.active());
  assert.ok(guard.blocksSubmit(enter));
  guard.end();
  assert.equal(guard.active(), false);
  assert.ok(guard.blocksSubmit(enter));
  time += 9;
  assert.ok(guard.blocksSubmit(enter));
  time += 1;
  assert.ok(!guard.blocksSubmit(enter));
  assert.ok(guard.blocksSubmit({ ...enter, keyCode: 229 }));
  assert.ok(guard.blocksSubmit({ ...enter, nativeEvent: { isComposing: true } }));
})

test('sidebar formats token counts and clocks like the host and renders the estimated context separately', () => {
  assert.equal(formatTokenCount(81_000), '81K')
  assert.equal(formatTokenCount(12_230), '12.2K')
  assert.equal(formatTokenCount(1_240_000), '1.2M')
  const today = new Date(2026, 10, 20, 9, 0).getTime()
  assert.equal(formatMessageTime(today, 'zh-CN', today), '09:00')
  assert.equal(formatMessageTime(new Date(2026, 10, 19, 8, 5).getTime(), 'zh-CN', today), '11月19日 08:05')
  assert.equal(formatMessageTime(new Date(2025, 10, 19, 8, 5).getTime(), 'zh-CN', today), '2025年11月19日 08:05')
  assert.deepEqual(contextReading({ contextWindow: 200, estimatedTokens: 50 }), { used: 50, contextWindow: 200, percent: 25 })
  assert.equal(contextReading({ contextWindow: 200 }), null)
  assert.equal(contextReading({ contextWindow: null }), null)
})

test('history places the newest creation last without reordering the received rows', () => {
  const rows = [
    { id: 'late', createdAt: 3, updatedAt: 4 },
    { id: 'b', createdAt: 2, updatedAt: 4 },
    { id: 'a', createdAt: 2, updatedAt: 3 },
    { id: 'early', createdAt: 1, updatedAt: 20 },
  ]
  assert.deepEqual(orderHistory(rows).map(row => row.id), ['early', 'a', 'b', 'late'])
  assert.deepEqual(rows.map(row => row.id), ['late', 'b', 'a', 'early'])
})

const flush = () => new Promise(resolve => queueMicrotask(resolve))

// Exercise transitions against the native sidebar's per-session inventory shape.
test('switching sessions keeps each sidebar destination and respects explicit collapse and close', async () => {
  const ctx = harness()
  const { sidebarRight, mounted } = ctx
  const controller = makeController(ctx)
  try {
    await flush()
    assert.equal(controller.getSnapshot().performanceUsage, 'detailed')
    controller.setPerformanceUsage('compact')
    assert.equal(controller.getSnapshot().performanceUsage, 'compact')
    assert.deepEqual(sidebarRight.tabsIn('main'), [ctx.files])
    assert.equal(controller.getSnapshot().pane, null)

    assert.equal(controller.openDetail('main', 'thread'), true)
    const reveal = sidebarRight.openTabIn
    sidebarRight.openTabIn = () => assert.fail('in-pane navigation must not open or focus a native tab')
    controller.navigate('main', null)
    assert.equal(controller.getSnapshot().pane.id, null)
    controller.navigate('main', 'thread')
    assert.equal(controller.getSnapshot().pane.id, 'thread')
    sidebarRight.openTabIn = reveal
    mounted.set('other')
    assert.equal(controller.getSnapshot().pane, null)
    assert.equal(controller.openList('main'), false)
    assert.equal(controller.openList('other'), true)
    mounted.set('main')
    await flush()
    assert.equal(sidebarRight.isExpanded(), true)
    assert.deepEqual(controller.getSnapshot().pane, { sessionId: 'main', id: 'thread', restored: true })
    assert.equal(sidebarRight.tabsIn('main').length, 2)

    sidebarRight.toggleExpanded()
    mounted.set('other')
    assert.equal(controller.getSnapshot().pane.id, null)
    mounted.set('main')
    assert.equal(sidebarRight.isExpanded(), false)
    assert.equal(controller.getSnapshot().pane.id, 'thread')

    sidebarRight.closeIn('main', 'kabxx-btw')
    mounted.set('other')
    mounted.set('main')
    await flush()
    assert.equal(controller.getSnapshot().pane, null)
    assert.deepEqual(sidebarRight.tabsIn('main'), [ctx.files])
  } finally {
    controller.dispose()
  }
})

test('unsent drafts stay with their session and thread until that draft is accepted', async () => {
  const ctx = harness()
  const controller = makeController(ctx)
  const receipt = Promise.withResolvers()
  const accepted = { turnIndex: 1 }
  try {
    controller.openDetail('main', 'first')
    controller.setDraft('main', 'first', 'Draft A')
    controller.navigate('main', null)
    controller.navigate('main', 'second')
    assert.equal(controller.getDraft('main', 'second').text, '')
    controller.setDraft('main', 'second', 'Draft B')
    ctx.mounted.set('other')
    controller.setDraft('other', 'first', 'Draft C')
    ctx.mounted.set('main')
    controller.navigate('main', 'first')
    assert.equal(controller.getDraft('main', 'first').text, 'Draft A')
    assert.equal(controller.getDraft('main', 'second').text, 'Draft B')
    assert.equal(controller.getDraft('other', 'first').text, 'Draft C')

    let sends = 0
    ctx.remote.btw.submitFollowup = (session, id, text) => {
      assert.deepEqual([session, id, text], ['main', 'first', 'Draft A'])
      sends += 1
      return receipt.promise
    }
    const pending = controller.submitDraft('main', 'first')
    assert.equal(controller.getDraft('main', 'first').saving, true)
    await controller.submitDraft('main', 'first')
    assert.equal(sends, 1)
    ctx.mounted.set('other')
    ctx.mounted.set('main')
    controller.setDraft('main', 'first', 'New input while sending')
    receipt.resolve({ ok: true, value: accepted })
    await pending
    assert.equal(controller.getDraft('main', 'first').text, 'New input while sending')
    assert.equal(controller.getDraft('main', 'first').receipt, accepted)
    assert.equal(controller.getDraft('main', 'first').saving, false)

    const rejection = Promise.withResolvers()
    ctx.remote.btw.submitFollowup = () => rejection.promise
    const rejected = controller.submitDraft('main', 'first')
    const checked = assert.rejects(rejected, /rejected/)
    ctx.mounted.set('other')
    rejection.resolve({ ok: false, error: { message: 'rejected' } })
    await checked
    ctx.mounted.set('main')
    assert.equal(controller.getDraft('main', 'first').text, 'New input while sending')
    assert.equal(controller.getDraft('main', 'first').error, 'sendFailed')
    assert.equal(controller.getDraft('main', 'second').error, undefined)
    ctx.remote.btw.submitFollowup = async () => ({ ok: true, value: { turnIndex: 2 } })
    await controller.submitDraft('main', 'first')
    assert.equal(controller.getDraft('main', 'first').text, '')
    assert.equal(controller.getDraft('main', 'first').error, undefined)
    assert.equal(controller.getDraft('main', 'second').text, 'Draft B')
  } finally {
    controller.dispose()
  }
  const reopened = makeController(ctx)
  try {
    assert.equal(reopened.getDraft('main', 'second').text, '')
  } finally {
    reopened.dispose()
  }
})

test('a lost follow-up receipt keeps the same submission ID until the question is accepted', async () => {
  const ctx = harness()
  const controller = makeController(ctx)
  const ids = []
  ctx.remote.btw.submitFollowup = async (_session, _thread, _question, id) => {
    ids.push(id)
    if (ids.length === 1) throw new Error('response lost')
    return { ok: true, value: { turnIndex: 1 } }
  }
  try {
    controller.setDraft('main', 'thread', 'continue')
    await assert.rejects(controller.submitDraft('main', 'thread'), /response lost/)
    ctx.mounted.set('other')
    ctx.mounted.set('main')
    await controller.submitDraft('main', 'thread')
    assert.match(ids[0], /^[a-f0-9]{32}$/u)
    assert.equal(ids[1], ids[0])
    assert.equal(controller.getDraft('main', 'thread').text, '')
    controller.setDraft('main', 'thread', 'continue')
    await controller.submitDraft('main', 'thread')
    assert.notEqual(ids[2], ids[0], 'a new intentional submission has its own ID')
  } finally {
    controller.dispose()
  }
})

test('a competing follow-up retains the draft and reports that the reply is generating', async () => {
  const ctx = harness()
  const controller = makeController(ctx)
  ctx.remote.btw.submitFollowup = async () => ({ ok: false, error: { code: 'btw/generating', message: 'Host rejection' } })
  try {
    controller.setDraft('main', 'thread', 'still unsent')
    await assert.rejects(controller.submitDraft('main', 'thread'), { code: 'btw/generating' })
    assert.equal(controller.getDraft('main', 'thread').text, 'still unsent')
    assert.equal(controller.getDraft('main', 'thread').error, 'stillGenerating')
    assert.equal(controller.getDraft('main', 'thread').saving, false)
    controller.clearGeneratingNotice('main', 'thread')
    assert.equal(controller.getDraft('main', 'thread').error, undefined)
    assert.equal(controller.getDraft('main', 'thread').text, 'still unsent')
  } finally {
    controller.dispose()
  }
})

test('each active first-question submission has its own ID even with identical text', async () => {
  const ctx = harness()
  const controller = makeController(ctx)
  const attempts = []
  ctx.remote.btw.submitCreate = (sessionId, question, id) => {
    assert.equal(sessionId, 'main')
    assert.equal(question, 'same question')
    const receipt = Promise.withResolvers()
    attempts.push({ id, receipt })
    return receipt.promise
  }
  const source = makeSource(controller, key => zh.ui[key])
  const { claim } = await source.matchEnter({ sessionId: 'main' }, '/侧问 same question',
    new AbortController().signal, { attachments: 0 })
  try {
    const submissions = [claim.submit('same question'), claim.submit('same question'), claim.submit('same question')]
    assert.equal(new Set(attempts.map(attempt => attempt.id)).size, 3)
    for (const attempt of attempts) assert.match(attempt.id, /^[a-f0-9]{32}$/u)
    for (const { id, receipt } of attempts.toReversed()) receipt.resolve({ ok: true, value: { id } })
    assert.deepEqual(await Promise.all(submissions), Array(3).fill({ kind: 'success' }))
    assert.equal(controller.getSnapshot().cards.main.id, attempts[2].id)
    assert.equal(controller.getSnapshot().listRevision, 3)
  } finally {
    controller.dispose()
  }
})

test('resending a rejected first question advances card ordering with a new ID', async () => {
  const ctx = harness()
  const controller = makeController(ctx)
  const attempts = []
  ctx.remote.btw.submitCreate = async (_sessionId, question, id) => {
    attempts.push(id)
    if (attempts.length === 1) return { ok: false, error: { code: 'btw/save-failed', message: 'Host rejection' } }
    return { ok: true, value: { id: question } }
  }
  try {
    await assert.rejects(controller.createCard('main', 'first'), { code: 'btw/save-failed' })
    await controller.createCard('main', 'second')
    await controller.createCard('main', 'first')
    assert.equal(new Set(attempts).size, 3)
    assert.equal(controller.getSnapshot().cards.main.id, 'first')
  } finally {
    controller.dispose()
  }
})

test('exact command interception, text-only envelope and independent submit', async () => {
  const ctx = harness()
  const call = []
  ctx.remote.btw.submitCreate = async (id, question) => {
    call.push([id, question])
    return { ok: true, value: { id: 'created' } }
  }
  const controller = makeController(ctx)
  const icon = () => null
  const source = makeSource(controller, key => zh.ui[key] ?? key, icon)
  const signal = new AbortController().signal
  const session = { sessionId: 'main' }
  const menu = query => source.candidates(session, { query, position: 'leading' })
  const [candidate] = await menu('')
  assert.deepEqual(candidate, { name: 'btw', label: '侧问', description: '发起侧问，或查看当前会话的侧问记录', icon })
  assert.deepEqual(await menu('bt'), [candidate])
  assert.deepEqual(await menu('侧'), [candidate])
  assert.deepEqual(await menu('goal'), [])
  const picked = source.onPick({ session, position: 'leading', candidate })
  assert.equal(picked.claim.token, '/侧问 ')
  assert.equal((await picked.claim.submit('')).kind, 'success')
  assert.equal((await source.matchClaim(session, '/侧问', signal)).token, '/侧问 ')
  assert.equal((await source.matchClaim(session, '/btw', signal)).token, '/btw ')
  const english = makeSource(controller, key => key === 'commandSpelling' ? 'btw' : key, icon)
  assert.equal(english.onPick({ session, position: 'leading', candidate }).claim.token, '/btw ')
  const match = (value, attachments = 0) => source.matchEnter(session, value, signal, { attachments })
  assert.equal(await match('/btw-other x'), undefined)
  assert.equal(await match('/侧问其他 x'), undefined)
  assert.equal(await match('/goal x'), undefined)
  assert.equal(await match('/BTW x'), undefined)
  await assert.rejects(match('/btw hi', 1), { message: zh.ui.textOnly })
  await assert.rejects(match('/侧问 hi', 1), { message: zh.ui.textOnly })
  assert.equal((await match('/btw')).claim.token, '/btw ')
  assert.equal((await match('/侧问')).claim.token, '/侧问 ')
  assert.equal((await (await match('/btw')).claim.submit('')).kind, 'success')
  assert.equal((await (await match('/侧问')).claim.submit('')).kind, 'success')
  assert.equal(controller.getSnapshot().pane.id, null)
  assert.equal((await (await match('/btw  继续讨论')).claim.submit('  继续讨论 ')).kind, 'success')
  assert.equal((await (await match('/侧问  再问一句')).claim.submit('  再问一句 ')).kind, 'success')
  assert.deepEqual(call, [['main', '继续讨论'], ['main', '再问一句']])
  assert.equal(controller.getSnapshot().cards.main.id, 'created')
  controller.dismiss('main', 'created')
  assert.deepEqual(controller.getSnapshot().cards, {})
  controller.dispose()
})

test('an unsaved session uses the localized native command error while leaving list access available', async () => {
  const ctx = harness()
  const session = { sessionId: 'main' }
  const signal = new AbortController().signal
  const controller = makeController(ctx)
  const rejected = { ok: false, error: { code: 'btw/session-not-saved', message: 'Host fallback' } }
  const draft = '我的草稿'
  try {
    for (const locale of [zh.ui, en.ui]) {
      const source = makeSource(controller, key => locale[key])
      const match = line => source.matchEnter(session, line, signal, { attachments: 0 })
      ctx.remote.btw.submitCreate = async (id, question) => {
        assert.equal(id, session.sessionId)
        assert.equal(question, draft)
        return rejected
      }
      const { claim } = await match(`/侧问 ${draft}`)
      assert.deepEqual(await claim.submit(draft), { kind: 'error', text: locale.sessionNotSaved })
      assert.deepEqual(controller.getSnapshot().cards, {})
      const list = await match('/btw')
      assert.deepEqual(await list.claim.submit(''), { kind: 'success' })
      assert.equal(controller.getSnapshot().pane.id, null)
      for (const [code, text] of [
        ['btw/model-unavailable', locale.modelUnavailable],
        ['btw/save-failed', locale.saveFailed],
      ]) {
        ctx.remote.btw.submitCreate = async () => ({ ok: false, error: { code, message: 'Host fallback' } })
        assert.deepEqual(await claim.submit(draft), { kind: 'error', text })
      }
      ctx.remote.btw.submitCreate = async () => ({ ok: false, error: { code: 'btw/unexpected', message: 'Host fallback' } })
      await assert.rejects(claim.submit(draft), { code: 'btw/unexpected', message: 'Host fallback' })
    }
  } finally {
    controller.dispose()
  }
})

test('explicitly reopening history resets its position but adding a card only refreshes the contents', async () => {
  const ctx = harness()
  ctx.remote.btw.submitCreate = async () => ({ ok: true, value: { id: 'new' } })
  const controller = makeController(ctx)
  try {
    assert.equal(controller.openList('main'), true)
    const first = controller.getSnapshot()
    await controller.createCard('main', 'question')
    assert.equal(controller.getSnapshot().pane.listOpenedAt, first.pane.listOpenedAt)
    assert.ok(controller.getSnapshot().listRevision > first.listRevision)
    assert.equal(controller.openList('main'), true)
    assert.ok(controller.getSnapshot().pane.listOpenedAt > first.pane.listOpenedAt)
  } finally {
    controller.dispose()
  }
})

test('a card stays until dismissed or replaced by a newer accepted side question', async () => {
  const ctx = harness()
  const controller = makeController(ctx)
  const accepted = id => ({ ok: true, value: { id } })
  try {
    ctx.remote.btw.submitCreate = async () => accepted('first')
    await controller.createCard('main', 'first')
    controller.openList('main')
    controller.openDetail('main', 'first')
    assert.equal(controller.getSnapshot().cards.main.id, 'first')

    const next = Promise.withResolvers()
    ctx.remote.btw.submitCreate = () => next.promise
    const pending = controller.createCard('main', 'next')
    ctx.remote.btw.submitCreate = async () => ({ ok: false, error: { message: 'rejected' } })
    await assert.rejects(controller.createCard('main', 'rejected'), /rejected/)
    assert.equal(controller.getSnapshot().cards.main.id, 'first')
    next.resolve(accepted('next'))
    await pending
    assert.equal(controller.getSnapshot().cards.main.id, 'next')

    const older = Promise.withResolvers()
    ctx.remote.btw.submitCreate = () => older.promise
    const late = controller.createCard('main', 'older')
    ctx.remote.btw.submitCreate = async () => accepted('newest')
    await controller.createCard('main', 'newest')
    assert.equal(controller.getSnapshot().cards.main.id, 'newest')
    controller.dismiss('main', 'newest')
    older.resolve(accepted('older'))
    await late
    assert.deepEqual(controller.getSnapshot().cards, {})
  } finally {
    controller.dispose()
  }
})

test('moving a card to the sidebar only dismisses it once the side question is visible', async () => {
  const ctx = harness()
  const { sidebarRight } = ctx
  const controller = makeController(ctx)
  const create = id => ({ ok: true, value: { id, sessionId: 'main', turns: [{ status: 'generating' }] } })
  try {
    await flush()
    ctx.remote.btw.submitCreate = async () => create('first')
    await controller.createCard('main', 'first')
    assert.equal(controller.openList('main'), true)
    sidebarRight.toggleExpanded()

    const open = sidebarRight.openTabIn
    sidebarRight.openTabIn = () => {}
    assert.equal(controller.moveCardToSidebar('main', 'first'), false)
    assert.equal(controller.getSnapshot().cards.main.id, 'first')
    assert.equal(controller.getSnapshot().pane.id, null)

    sidebarRight.openTabIn = open
    assert.equal(controller.moveCardToSidebar('main', 'stale'), false)
    assert.equal(controller.getSnapshot().cards.main.id, 'first')
    assert.equal(controller.moveCardToSidebar('main', 'first'), true)
    assert.equal(sidebarRight.isExpanded(), true)
    assert.deepEqual(controller.getSnapshot().pane, { sessionId: 'main', id: 'first' })
    assert.deepEqual(controller.getSnapshot().cards, {})
    assert.equal(controller.moveCardToSidebar('main', 'first'), false)
  } finally {
    controller.dispose()
  }
})

test('a card restores on return and page reopen until dismissed or moved to the sidebar', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const preferences = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => preferences.get(key) ?? null,
    setItem: (key, value) => preferences.set(key, value),
    removeItem: key => preferences.delete(key),
  } })
  const ctx = harness()
  const crashed = { id: 'finished', sessionId: 'main', turns: [{ reply: 'saved reply' }] }
  const controllers = []
  const start = () => {
    const controller = makeController(ctx)
    controllers.push(controller)
    return controller
  }
  ctx.remote.btw.submitCreate = async () => ({ ok: true, value: { ...crashed, turns: [] } })
  ctx.remote.btw.get = async (sessionId, id) => {
    assert.equal(sessionId, 'main')
    assert.equal(id, 'finished')
    return { ok: true, value: crashed }
  }
  try {
    const first = start()
    await flush()
    await first.createCard('main', 'question')
    first.openDetail('main', 'finished')
    ctx.mounted.set('other')
    await first.restoreCard('other')
    assert.deepEqual(first.getSnapshot().cards, {})
    ctx.mounted.set('main')
    await first.restoreCard('main')
    assert.deepEqual(first.getSnapshot().cards.main, crashed)
    assert.equal(first.getSnapshot().pane.id, 'finished')
    first.dispose()

    // The native layout can still contain a disk-restored tab on a page load.
    ctx.sidebarRight.openTabIn('main', 'kabxx-btw')
    const reopened = start()
    await flush()
    await reopened.restoreCard('main')
    assert.deepEqual(ctx.sidebarRight.tabsIn('main'), [ctx.files])
    assert.equal(reopened.getSnapshot().pane, null)
    assert.deepEqual(reopened.getSnapshot().cards.main, crashed)
    assert.equal(reopened.moveCardToSidebar('main', 'finished'), true)
    ctx.sidebarRight.closeIn('main', 'kabxx-btw')
    await reopened.restoreCard('main')
    assert.deepEqual(reopened.getSnapshot().cards, {})
    reopened.dispose()

    const afterMove = start()
    await afterMove.restoreCard('main')
    assert.deepEqual(afterMove.getSnapshot().cards, {})
  } finally {
    for (const controller of controllers) controller.dispose()
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
})

test('a remembered card restores on reconnect whether the first read already failed or is still pending', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const detail = { id: 'remembered', sessionId: 'main' }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => key === 'dsh.btw.card.main' ? detail.id : null,
  } })
  try {
    for (const reconnectBeforeFailure of [false, true]) {
      const ctx = harness()
      const interrupted = Promise.withResolvers()
      let reads = 0
      ctx.remote.btw.get = (sessionId, id) => {
        assert.equal(sessionId, 'main')
        assert.equal(id, detail.id)
        reads += 1
        return reads === 1 ? interrupted.promise : Promise.resolve({ ok: true, value: detail })
      }
      const controller = makeController(ctx)
      try {
        const firstRestore = controller.restoreCard('main')
        assert.equal(controller.restoreCard('main'), firstRestore)
        await flush()
        assert.equal(reads, 1)
        if (reconnectBeforeFailure) ctx.emit('connection/reset')
        interrupted.reject(new Error('connection lost'))
        await firstRestore
        if (!reconnectBeforeFailure) {
          assert.deepEqual(controller.getSnapshot().cards, {})
          assert.equal(reads, 1)
          ctx.emit('connection/reset')
        }
        // Two simultaneous notifications may share the same restore read.
        ctx.emit('connection/reset')
        await flush()
        await flush()
        assert.equal(controller.getSnapshot().cards.main, detail)
        assert.equal(reads, 2)
        assert.equal(controller.getSnapshot().pane, null)
        controller.dismiss('main', detail.id)
        ctx.emit('connection/reset')
        await flush()
        assert.equal(reads, 2)
        assert.deepEqual(controller.getSnapshot().cards, {})
      } finally {
        controller.dispose()
      }
      ctx.emit('connection/reset')
      await flush()
      assert.equal(reads, 2)
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
})

test('a reconnect read cannot restore a stale card after a session switch or a replacement', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => key === 'dsh.btw.card.main' ? 'older' : null,
  } })
  try {
    for (const replace of [false, true]) {
      const ctx = harness()
      const found = Promise.withResolvers()
      ctx.remote.btw.get = () => found.promise
      const newer = { sessionId: 'main', id: 'newer' }
      ctx.remote.btw.submitCreate = async () => ({ ok: true, value: newer })
      const controller = makeController(ctx)
      try {
        ctx.emit('connection/reset')
        const pending = controller.restoreCard('main')
        await flush()
        if (replace) {
          await controller.createCard('main', 'new question')
          controller.dismiss('main', newer.id)
        } else {
          ctx.mounted.set('other')
          ctx.mounted.set('main')
        }
        found.resolve({ ok: true, value: { sessionId: 'main', id: 'older' } })
        await pending
        assert.deepEqual(controller.getSnapshot().cards, {})
      } finally {
        controller.dispose()
      }
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
})

test('dismissing an older card in another tab preserves the newer card on reload', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const preferences = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => preferences.get(key) ?? null,
    setItem: (key, value) => preferences.set(key, value),
    removeItem: key => preferences.delete(key),
  } })
  const controllers = []
  const start = () => {
    const ctx = harness()
    ctx.remote.btw.submitCreate = async (sessionId, id) => ({ ok: true, value: { sessionId, id } })
    ctx.remote.btw.get = ctx.remote.btw.submitCreate
    const controller = makeController(ctx)
    controllers.push(controller)
    return controller
  }
  try {
    for (const closeOlder of [
      controller => controller.dismiss('main', 'older'),
      controller => assert.equal(controller.moveCardToSidebar('main', 'older'), true),
    ]) {
      preferences.clear()
      const oldTab = start()
      await oldTab.createCard('main', 'older')
      await start().createCard('main', 'newer')
      closeOlder(oldTab)
      assert.deepEqual(oldTab.getSnapshot().cards, {})
      const reloaded = start()
      await reloaded.restoreCard('main')
      assert.equal(reloaded.getSnapshot().cards.main.id, 'newer')
      reloaded.dismiss('main', 'older')
      assert.equal(reloaded.getSnapshot().cards.main.id, 'newer')
      reloaded.dismiss('main', 'newer')
      assert.equal(preferences.size, 0)
    }
  } finally {
    for (const controller of controllers) controller.dispose()
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
})

test('a late create receipt is remembered only for its own session', async () => {
  const ctx = harness()
  const receipt = Promise.withResolvers()
  ctx.remote.btw.submitCreate = () => receipt.promise
  const detail = { id: 'accepted', sessionId: 'main' }
  ctx.remote.btw.get = async () => ({ ok: true, value: detail })
  const controller = makeController(ctx)
  try {
    const pending = controller.createCard('main', 'question')
    ctx.mounted.set('other')
    receipt.resolve({ ok: true, value: detail })
    await pending
    assert.deepEqual(controller.getSnapshot().cards, {})
    ctx.mounted.set('main')
    await controller.restoreCard('main')
    assert.equal(controller.getSnapshot().cards.main, detail)
  } finally {
    controller.dispose()
  }
})

test('dictation takes duration, byte budget and selection from the DSH catalog per recording', async () => {
  const ctx = harness()
  const requests = []
  ctx.remote.speech = {
    async transcribe(request, signal) {
      requests.push({ request, signal })
      return { ok: true, value: { text: 'draft' } }
    },
  }
  const controller = makeController(ctx)
  try {
    const catalog = (providerId, maxDurationSeconds, maxAudioBytes) => ({
      selection: { providerId }, maxDurationSeconds, maxAudioBytes,
      providers: [{ id: providerId, preparation: { phase: 'ready' } }],
    })
    assert.equal(controller.beginDictation(), undefined)
    controller.setSpeechCatalog({ ...catalog('first', 73, 4), providers: [{ id: 'first', preparation: { phase: 'unprepared' } }] }, ctx.remote.speech)
    assert.equal(controller.getSnapshot().speechMounted, true)
    assert.equal(controller.getSnapshot().dictationAvailable, false)
    assert.equal(controller.beginDictation(), undefined)
    controller.setSpeechCatalog(catalog('first', 73, 4), ctx.remote.speech)
    const first = controller.beginDictation()
    controller.setSpeechCatalog(catalog('second', 14, 9), ctx.remote.speech)
    const second = controller.beginDictation()
    assert.equal(first.maxDurationSeconds, 73)
    assert.equal(second.maxDurationSeconds, 14)
    const signal = new AbortController().signal
    await assert.rejects(first.transcribe(new Blob(['abcde']), signal), /too large/)
    assert.equal(await first.transcribe(new Blob(['abcd']), signal), 'draft')
    assert.equal(await second.transcribe(new Blob(['abcde']), signal), 'draft')
    assert.deepEqual(requests, [
      { request: { audioBase64: 'YWJjZA==', providerId: 'first' }, signal },
      { request: { audioBase64: 'YWJjZGU=', providerId: 'second' }, signal },
    ])
    controller.setSpeechCatalog(undefined)
    assert.equal(controller.getSnapshot().speechMounted, false)
    assert.equal(controller.beginDictation(), undefined)
  } finally {
    controller.dispose()
  }
})

test('speech readiness follows native reconnects and reopens an ended readiness stream', { timeout: 8000 }, async () => {
  const fromDsh = createRequire(resolve(process.env.DSH_INSTALL_DIR, 'package.json'))
  const { RemoteStream, RemoteStreamCarrierError } = await import(pathToFileURL(fromDsh.resolve('@deepseek-ai/dsh-api-gateway/client')).href)
  const ctx = harness()
  const controller = makeController(ctx)
  const generation = snapshot({})
  const disconnected = Promise.withResolvers()
  const hostClosed = Promise.withResolvers()
  const ready = (providerId, maxDurationSeconds) => ({
    selection: { providerId }, maxDurationSeconds, maxAudioBytes: 10,
    providers: [{ id: providerId, preparation: { phase: 'ready' } }],
  })
  const signals = []
  const speech = {
    async *follow(signal) {
      signals.push(signal)
      if (signals.length === 1) {
        yield ready('before', 31)
        await disconnected.promise
        throw new RemoteStreamCarrierError('The test connection dropped')
      }
      if (signals.length === 2) {
        yield ready('after', 73)
        await hostClosed.promise
        return
      }
      yield ready('reopened', 89)
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    },
  }
  const waitFor = predicate => new Promise(resolve => {
    if (predicate()) { resolve(); return }
    const stop = controller.subscribe(() => {
      if (predicate()) { stop(); resolve() }
    })
  })
  const stop = observeSpeech({ speech, $stream: options => new RemoteStream({ generation }, options) }, controller)
  try {
    await waitFor(() => controller.beginDictation()?.maxDurationSeconds === 31)
    generation.set(undefined)
    const fellOffline = waitFor(() => !controller.getSnapshot().dictationAvailable)
    disconnected.resolve()
    await fellOffline
    assert.equal(controller.getSnapshot().speechMounted, true)
    assert.equal(signals.length, 1)
    const recovered = waitFor(() => controller.beginDictation()?.maxDurationSeconds === 73)
    generation.set({})
    await recovered
    assert.equal(signals.length, 2)
    const reopened = waitFor(() => controller.beginDictation()?.maxDurationSeconds === 89)
    hostClosed.resolve()
    await reopened
    assert.equal(signals.length, 3)
  } finally {
    disconnected.resolve()
    hostClosed.resolve()
    await stop()
    controller.dispose()
  }
  assert.ok(signals.every(signal => signal.aborted))
  assert.equal(controller.getSnapshot().speechMounted, false)
})

test('a sidebar thread reopens with current history after a native carrier loss', { timeout: 8000 }, async () => {
  const fromDsh = createRequire(resolve(process.env.DSH_INSTALL_DIR, 'package.json'))
  const { RemoteStream, RemoteStreamCarrierError } = await import(pathToFileURL(fromDsh.resolve('@deepseek-ai/dsh-api-gateway/client')).href)
  const ctx = harness()
  const generation = snapshot({})
  const disconnect = Promise.withResolvers()
  const first = Promise.withResolvers()
  const offline = Promise.withResolvers()
  const second = Promise.withResolvers()
  const signals = []
  ctx.remote.$stream = options => new RemoteStream({ generation }, options)
  ctx.remote.btw.watchThread = async function* (_session, _id, signal) {
    signals.push(signal)
    yield { kind: 'snapshot', detail: { version: signals.length } }
    if (signals.length === 1) {
      await disconnect.promise
      throw new RemoteStreamCarrierError('The test connection dropped')
    }
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  }
  const controller = makeController(ctx)
  const stop = controller.watchThread('main', 'thread', event => {
    if (event.detail.version === 1) first.resolve(event)
    else second.resolve(event)
  }, offline.resolve)
  try {
    assert.equal((await first.promise).kind, 'snapshot')
    generation.set(undefined)
    disconnect.resolve()
    assert.match((await offline.promise).message, /connection dropped/)
    assert.equal(signals.length, 1)
    generation.set({})
    assert.equal((await second.promise).detail.version, 2)
  } finally {
    disconnect.resolve()
    stop()
    controller.dispose()
  }
  assert.ok(signals.every(signal => signal.aborted))
})

test('dropping a UI subscription aborts only its own Remote stream', async () => {
  const ctx = harness()
  const signals = []
  ctx.remote.btw.watch = function (session, thread, version, signal) {
    assert.equal(session, 'main')
    assert.equal(version, null)
    signals.push(signal)
    return (async function* () {
      yield { id: thread }
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    })()
  }
  const controller = makeController(ctx)
  const first = Promise.withResolvers()
  const second = Promise.withResolvers()
  const stop = controller.watch('main', 'thread', first.resolve)
  controller.watch('main', 'thread', second.resolve)
  assert.equal((await first.promise).id, 'thread')
  await second.promise
  stop()
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  controller.dispose()
  assert.equal(signals[1].aborted, true)
})

test('the side pane applies admitted turns and reply increments without rebuilding old turns', () => {
  const old = { question: 'old', reply: 'keep me', status: 'completed' }
  const initial = { id: 'thread', sessionId: 'main', version: 3, turns: [old] }
  const change = (version, firstTurn, turns, reply) => ({ kind: 'change', version, updatedAt: version, firstTurn, turns, reply })
  const admitted = { question: 'new', reply: '', status: 'generating' }
  const pending = applyThreadEvent(initial, change(4, 1, [admitted]))
  assert.equal(applyThreadEvent(pending, change(4, 1, [admitted])), pending)
  const prefix = applyThreadEvent(pending, change(6, 2, [], { offset: 0, text: 'first', status: 'generating' }))
  const third = { question: 'third', reply: '', status: 'generating' }
  const answer = applyThreadEvent(prefix, change(9, 2, [third], {
    offset: 5, text: ' second', status: 'completed', finishedAt: 123, usage: { outputTokens: 7 },
  }))
  assert.equal(answer.turns[0], old)
  assert.equal(answer.turns[1].reply, 'first second')
  assert.equal(answer.turns[1].finishedAt, 123)
  assert.deepEqual(answer.turns[1].usage, { outputTokens: 7 })
  assert.equal(answer.turns[2], third)
  assert.equal(applyThreadEvent(answer, change(6, 2, [])), answer)
  assert.throws(() => applyThreadEvent(answer, change(10, 2, [])), /turn position/)
  assert.throws(() => applyThreadEvent(prefix, change(10, 2, [], {
    offset: 6, text: 'missed text', status: 'generating',
  })), /reply offset/)
})

test('wire keeps generation success separate from a failed archive write', () => {
  const sessionId = 'session-'.repeat(40)
  const detail = { id: 'thread', sessionId, version: 1, turns: [{ question: 'new', reply: 'answer', status: 'generating', createdAt: 1 }] }
  const updated = applyReply(detail, 0, { version: 2, updatedAt: 2, offset: 6, text: '', status: 'completed', finishedAt: 2, saveError: 'write-failure' })
  assert.equal(parseSessionId(sessionId), sessionId)
  assert.deepEqual(parseTurn(updated.turns[0]), {
    question: 'new', reply: 'answer', status: 'completed', createdAt: 1, finishedAt: 2, saveError: 'write-failure',
  })
  const longError = 'error '.repeat(100)
  assert.equal(parseTurn({ ...updated.turns[0], status: 'failed', error: longError }).error, longError)
})

test('installed Cordis and Gateway let the real plugin caller resolve remote.btw', { timeout: 8000 }, async () => {
  const fromDsh = name => import(pathToFileURL(createRequire(resolve(process.env.DSH_INSTALL_DIR, 'package.json')).resolve(name)).href)
  const [{ Context }, { TypertRegistry }, gateway] = await Promise.all([
    fromDsh('@deepseek-ai/cordis'), fromDsh('@deepseek-ai/dsh-typert-registry'), fromDsh('@deepseek-ai/dsh-api-gateway/client'),
  ])
  const ctx = new Context()
  const capture = harness()
  const calls = []
  let source
  const dispose = () => {}
  const thread = 'btw-00000000-0000-0000-0000-000000000001'
  ctx.provide('sidebarRight', capture.sidebarRight)
  ctx.provide('sidebarRightTabs', { register: () => dispose })
  ctx.provide('slots', { inject: (_, install) => install(), register: () => dispose })
  ctx.provide('locale', { register: () => dispose, bind: () => key => key })
  ctx.provide('inputTriggers', { registerSource: value => { source = value; return dispose } })
  ctx.provide('connection', {
    interactions: 'none',
    rpc: {
      open() { assert.fail('unexpected stream') },
      async call(path, endpoint, payload) {
        calls.push({ path, endpoint, args: { ...payload.args } })
        return { ok: true, value: { id: thread } }
      },
    },
  })
  await ctx.plugin(TypertRegistry)
  const gatewayFiber = ctx.plugin(gateway)
  await gatewayFiber
  const pluginFiber = ctx.plugin({ inject, apply: scope => mountClient(scope, {}) })
  try {
    await pluginFiber
    assert.ok(source)
    const { claim } = await source.matchEnter({ sessionId: 'main' }, '/btw test', new AbortController().signal, { attachments: 0 })
    assert.equal((await claim.submit('test')).kind, 'success')
    assert.equal(calls.length, 1)
    const [{ path, endpoint, args }] = calls
    assert.equal(path, '/api')
    assert.equal(endpoint, 'btw/submitCreate')
    assert.equal(args.agentId, 'main')
    assert.equal(args.question, 'test')
    assert.match(args.submissionId, /^[a-f0-9]{32}$/u)
  } finally {
    await pluginFiber.dispose()
    await gatewayFiber.dispose()
  }
})
