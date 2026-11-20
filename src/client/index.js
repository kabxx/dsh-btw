import { PACKAGE_NAME, TYPERT_REMOTE } from '../shared/wire.js'
import { createViews } from './views.js'
import en from '../../locale/en.json' with { type: 'json' }
import zh from '../../locale/zh.json' with { type: 'json' }

const plugin = PACKAGE_NAME
const tabKind = 'kabxx-btw'
const namespace = 'dshBtw'
const voiceBundle = '@deepseek-ai/dsh-experimental-voice-input-bundle'
const defaultPerformanceUsage = 'detailed'
const microphonePreference = 'dsh.voice-input.microphone'
const cardPreferencePrefix = 'dsh.btw.card.'
const emptyDraft = { text: '', revision: 0, saving: false }

// The installed Voice Input client persists a raw { id, label } snapshot.
// Read it when recording starts, so a settings change applies to the next click.
function getMicrophoneDevice() {
  try {
    const device = JSON.parse(globalThis.localStorage?.getItem(microphonePreference) ?? 'null')
    if (typeof device?.id === 'string' && typeof device.label === 'string') return device.id
  } catch { /* Unavailable browser storage follows the system input. */ }
  return ''
}

export const inject = ['slots', 'locale', 'remote', 'inputTriggers', 'sidebarRightTabs', 'sidebarRight']

export function unwrap(result) {
  if (result.ok) return result.value
  const error = new Error(result.error?.message ?? 'BTW request failed')
  error.code = result.error?.code
  throw error
}

function base64(bytes) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(binary)
}

export function makeController(ctx) {
  const sidebar = ctx.sidebarRight
  const listeners = new Set()
  const draftListeners = new Set()
  const drafts = new Map()
  const activeStreams = new Set()
  let snapshot = {
    cards: {}, pane: null, notice: {}, dictationAvailable: false, speechMounted: false,
    speechSettings: null, listRevision: 0, performanceUsage: defaultPerformanceUsage,
  }
  let session = sidebar.mounted.getSnapshot()
  let selectionRevision = 0
  const panes = new Map()
  const cardIds = new Map()
  const lastAcceptedCards = new Map()
  let lastCardRequest = 0
  let speechCatalog
  let speechRemote
  let disposed = false
  let closeQueued = false

  function publish(next) {
    if (disposed) return
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener()
  }

  function closeTabs(id) {
    if (id === undefined) return
    for (const tab of sidebar.tabsIn(id)) {
      if (tab.kind === tabKind) sidebar.closeIn(id, tab.id)
    }
  }

  // DSH retains its own expanded state and active tab for each Session.
  function pruneRestored() {
    if (!disposed && !panes.has(session)) closeTabs(session)
  }

  function queuePrune() {
    if (closeQueued) return
    closeQueued = true
    queueMicrotask(() => {
      closeQueued = false
      pruneRestored()
    })
  }

  function navigatePane(sessionId, id) {
    const listRevision = snapshot.listRevision + 1
    const pane = id === null ? { sessionId, id, listOpenedAt: listRevision } : { sessionId, id }
    panes.set(sessionId, pane)
    publish(id === null ? { pane, listRevision } : { pane })
  }

  function open(sessionId, id) {
    if (disposed || session !== sessionId) return false
    sidebar.openTabIn(sessionId, tabKind)
    if (disposed || session !== sessionId || !sidebar.isExpanded() || sidebar.active()?.kind !== tabKind) return false
    navigatePane(sessionId, id)
    return true
  }

  function cardIdFor(sessionId) {
    if (!cardIds.has(sessionId)) {
      let id = null
      try { id = globalThis.localStorage?.getItem(cardPreferencePrefix + sessionId) ?? null }
      catch { /* The current page can still remember the card in memory. */ }
      cardIds.set(sessionId, id)
    }
    return cardIds.get(sessionId)
  }

  function rememberCard(sessionId, id) {
    cardIds.set(sessionId, id)
    try {
      if (id === null) globalThis.localStorage?.removeItem(cardPreferencePrefix + sessionId)
      else globalThis.localStorage?.setItem(cardPreferencePrefix + sessionId, id)
    } catch { /* The current page can still remember the card in memory. */ }
  }

  function dismissCard(id) {
    rememberCard(id, null)
    const cards = { ...snapshot.cards }
    delete cards[id]
    publish({ cards })
  }

  async function restoreCard(sessionId) {
    if (disposed || sessionId === undefined || session !== sessionId || snapshot.cards[sessionId]) return
    const id = cardIdFor(sessionId)
    if (!id) return
    const revision = selectionRevision
    const stillCurrent = () => !disposed && selectionRevision === revision && cardIdFor(sessionId) === id
    try {
      const detail = unwrap(await ctx.remote.btw.get(sessionId, id))
      if (stillCurrent() && detail.id === id && detail.sessionId === sessionId && !snapshot.cards[sessionId]) {
        publish({ cards: { ...snapshot.cards, [sessionId]: detail } })
      }
    } catch (error) {
      if (stillCurrent() && error.code === 'btw/not-found') rememberCard(sessionId, null)
    }
  }

  const disposeSelection = sidebar.mounted.subscribe(() => {
    const current = sidebar.mounted.getSnapshot()
    if (current === session) return
    session = current
    selectionRevision += 1
    const pane = panes.get(session)
    publish({ cards: {}, pane: pane ? { ...pane, restored: true } : null, notice: {} })
    queuePrune()
  })
  const disposeInventory = sidebar.openTabs.subscribe(() => {
    const openSessions = new Set(sidebar.openTabs.getSnapshot().filter(tab => tab.kind === tabKind).map(tab => tab.sessionId))
    for (const id of panes.keys()) {
      if (!openSessions.has(id)) panes.delete(id)
    }
    if (snapshot.pane && !panes.has(snapshot.pane.sessionId)) publish({ pane: null })
    queuePrune()
  })
  queuePrune()

  function observe(start, settled, onNext, onError) {
    const controller = new AbortController()
    activeStreams.add(controller)
    void (async () => {
      let stream
      let last
      try {
        stream = start(controller.signal)
        for await (const value of stream) {
          last = value
          if (!controller.signal.aborted) onNext(value)
        }
        if (!controller.signal.aborted && (!last || !settled(last))) {
          onError?.(new Error('BTW stream ended before the reply settled'))
        }
      } catch (error) {
        if (!controller.signal.aborted) onError?.(error)
      } finally {
        activeStreams.delete(controller)
        stream?.dispose?.()
      }
    })()
    return () => controller.abort()
  }

  function draftKey(sessionId, id) { return JSON.stringify([sessionId, id]) }

  function getDraft(sessionId, id) { return drafts.get(draftKey(sessionId, id)) ?? emptyDraft }

  function publishDraft(sessionId, id, value) {
    if (disposed) return
    drafts.set(draftKey(sessionId, id), value)
    for (const listener of [...draftListeners]) listener()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    subscribeDrafts(listener) {
      draftListeners.add(listener)
      return () => draftListeners.delete(listener)
    },
    getDraft,
    setDraft(sessionId, id, text) {
      const draft = getDraft(sessionId, id)
      publishDraft(sessionId, id, { ...draft, text, revision: draft.revision + 1, error: undefined })
    },
    async submitDraft(sessionId, id) {
      const draft = getDraft(sessionId, id)
      if (disposed || draft.saving || !draft.text.trim()) return
      publishDraft(sessionId, id, { ...draft, saving: true, error: undefined })
      try {
        const receipt = unwrap(await ctx.remote.btw.followup(sessionId, id, draft.text))
        const current = getDraft(sessionId, id)
        const remaining = current.revision === draft.revision
          ? { text: '', revision: current.revision + 1 } : {}
        publishDraft(sessionId, id, { ...current, ...remaining, saving: false, receipt })
      } catch (error) {
        const messageKey = error?.code === 'btw/context-overflow' ? 'contextOverflow' : 'sendFailed'
        publishDraft(sessionId, id, { ...getDraft(sessionId, id), saving: false, error: messageKey })
        throw error
      }
    },
    openList: id => open(id, null),
    openDetail: (sessionId, id) => open(sessionId, id),
    moveCardToSidebar(sessionId, id) {
      if (snapshot.cards[sessionId]?.id !== id || !open(sessionId, id)) return false
      if (snapshot.cards[sessionId]?.id === id) dismissCard(sessionId)
      return true
    },
    navigate(sessionId, id) {
      if (!disposed && session === sessionId && panes.has(sessionId)) navigatePane(sessionId, id)
    },
    restoreCard,
    dismiss: dismissCard,
    async createCard(id, question) {
      const request = ++lastCardRequest
      const detail = unwrap(await ctx.remote.btw.create(id, question))
      if (disposed) return
      const listRevision = snapshot.listRevision + 1
      if (request <= (lastAcceptedCards.get(id) ?? 0)) {
        if (session === id) publish({ listRevision })
        return
      }
      lastAcceptedCards.set(id, request)
      rememberCard(id, detail.id)
      if (session === id) publish({ cards: { ...snapshot.cards, [id]: detail }, listRevision })
    },
    async call(name, ...args) { return unwrap(await ctx.remote.btw[name](...args)) },
    watch(sessionId, id, onNext, onError) {
      return observe(signal => ctx.remote.btw.watch(sessionId, id, null, signal),
        detail => detail.turns.at(-1)?.status !== 'generating', onNext, onError)
    },
    watchReply(sessionId, id, turnIndex, version, onNext, onError) {
      return observe(signal => ctx.remote.btw.watchReply(sessionId, id, turnIndex, version, signal),
        update => update.status !== 'generating', onNext, onError)
    },
    pruneRestored,
    setPerformanceUsage(value) {
      const performanceUsage = value === 'compact' ? value : defaultPerformanceUsage
      if (performanceUsage !== snapshot.performanceUsage) publish({ performanceUsage })
    },
    setSpeechCatalog(catalog, remote) {
      speechCatalog = catalog
      speechRemote = remote
      const model = catalog?.selection?.providerId
      const provider = catalog?.providers?.find(item => item.id === model)
      const available = provider !== undefined && ['ready', 'standby', 'waking'].includes(provider.preparation?.phase)
      const speechMounted = remote !== undefined
      if (available !== snapshot.dictationAvailable || speechMounted !== snapshot.speechMounted) {
        publish({ dictationAvailable: available, speechMounted })
      }
    },
    setSpeechSettings(speechSettings) { publish({ speechSettings }) },
    beginDictation() {
      const catalog = speechCatalog
      const speech = speechRemote
      if (!speech || !catalog?.selection || !snapshot.dictationAvailable) return undefined
      const { selection, maxDurationSeconds, maxAudioBytes } = catalog
      const microphoneId = getMicrophoneDevice()
      return {
        maxDurationSeconds,
        constraints: {
          audio: {
            echoCancellation: true, noiseSuppression: true,
            ...(microphoneId && { deviceId: { exact: microphoneId } }),
          },
          video: false,
        },
        async transcribe(blob, signal) {
          if (blob.size > maxAudioBytes) {
            const error = new Error('Recording is too large')
            error.code = 'btw/recording-too-large'
            throw error
          }
          signal.throwIfAborted()
          const audioBase64 = base64(new Uint8Array(await blob.arrayBuffer()))
          signal.throwIfAborted()
          return unwrap(await speech.transcribe({ audioBase64, ...selection }, signal)).text
        },
      }
    },
    dispose() {
      disposed = true
      disposeSelection()
      disposeInventory()
      closeTabs(session)
      for (const controller of activeStreams) controller.abort()
      listeners.clear()
      draftListeners.clear()
      drafts.clear()
    },
  }
}

export function makeSource(controller, t, icon) {
  const command = 'btw'
  const localizedCommand = '侧问'
  const supportedCommands = new Set([command, localizedCommand])
  const claim = (sessionId, spelling) => ({
    claim: {
      name: command, token: `/${spelling} `, hint: t('commandHint'), attachments: false,
      async submit(args) {
        const question = args.trim()
        if (question) {
          try {
            await controller.createCard(sessionId, question)
          } catch (error) {
            switch (error?.code) {
              case 'btw/session-not-saved': return { kind: 'error', text: t('sessionNotSaved') }
              case 'btw/model-unavailable': return { kind: 'error', text: t('modelUnavailable') }
              case 'btw/save-failed': return { kind: 'error', text: t('saveFailed') }
              default: throw error
            }
          }
        } else if (!controller.openList(sessionId)) {
          return { kind: 'error', text: t('sidebarUnavailable') }
        }
        return { kind: 'success' }
      },
    },
  })
  return {
    trigger: '/', name: plugin, showGroupTitle: false,
    async candidates(_session, { query, position }) {
      const label = t('commandLabel')
      const search = query.toLowerCase()
      return position === 'leading' && (command.startsWith(search) || label.toLowerCase().startsWith(search))
        ? [{ name: command, label, description: t('commandDescription'), icon }] : []
    },
    onPick({ session, position, candidate }) {
      if (position === 'leading' && candidate.name === command) {
        const preferred = t('commandSpelling')
        return claim(session.sessionId, supportedCommands.has(preferred) ? preferred : command)
      }
    },
    async matchClaim(session, token, signal) {
      signal.throwIfAborted()
      const spelling = token.slice(1)
      if (token.startsWith('/') && supportedCommands.has(spelling)) return claim(session.sessionId, spelling).claim
    },
    async matchEnter(session, line, signal, envelope) {
      const spelling = /^\/(\S+)/u.exec(line)?.[1]
      if (!supportedCommands.has(spelling)) return undefined
      signal.throwIfAborted()
      if (envelope.attachments) throw new Error(t('textOnly'))
      return claim(session.sessionId, spelling)
    },
  }
}

export async function mountClient(ctx, React) {
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => disposeRemote)
  await ctx.inject(['remote', 'remote.btw'], scope => mountFeatures(scope, React))
}

export function observeSpeech(remote, controller) {
  const speech = remote.speech
  let disposed = false
  const unavailable = () => {
    if (!disposed) controller.setSpeechCatalog(undefined, speech)
  }
  unavailable()
  const stream = remote.$stream({
    name: 'BTW speech readiness',
    open: signal => speech.follow(signal),
    ended: accepted => {
      unavailable()
      // Readiness stays subscribed after an accepted baseline, including a clean Host stream close.
      if (accepted) stream.restart()
      return new Error('BTW speech readiness stream ended')
    },
    carrierFailed: unavailable,
  })
  const observing = (async () => {
    try {
      for await (const item of stream) {
        if (disposed) break
        controller.setSpeechCatalog(item.value, speech)
        item.accept()
      }
    } catch {
      unavailable()
    }
  })()
  return async () => {
    disposed = true
    controller.setSpeechCatalog(undefined)
    await stream.dispose()
    await observing
  }
}

function mountFeatures(ctx, React) {
  ctx.effect(() => ctx.locale.register(namespace, { en: en.ui, zh: zh.ui }))
  const t = ctx.locale.bind(namespace)
  const controller = makeController(ctx)
  ctx.effect(() => controller.dispose)
  const { Dock, Pane, CommandIcon } = createViews(React)
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: plugin, kind: tabKind, title: () => t('title') }))
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'kabxx-btw-dock', order: 30, locale: namespace,
  }, props => {
    React.useLayoutEffect(() => { controller.pruneRestored() }, [props.sessionId])
    return React.createElement(Dock, { ...props, controller, t: props.t ?? t })
  })))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: plugin, locale: namespace,
  }, props => {
    const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
    React.useLayoutEffect(() => { controller.pruneRestored() }, [props.sessionId])
    if (snapshot.pane?.sessionId !== props.sessionId) return null
    return React.createElement(Pane, { ...props, controller, t: props.t ?? t })
  })))
  ctx.effect(() => ctx.inputTriggers.registerSource(makeSource(controller, t, CommandIcon)))
  ctx.inject(['configForms'], scope => {
    scope.effect(() => {
      const chatSettings = scope.configForms.get('ui-chat')
      const sync = () => controller.setPerformanceUsage(chatSettings.getSnapshot().value?.performanceUsage)
      const unsubscribe = chatSettings.subscribe(sync)
      sync()
      return () => {
        unsubscribe()
        controller.setPerformanceUsage(defaultPerformanceUsage)
      }
    })
  })
  ctx.inject(['pluginNavigation'], scope => {
    scope.effect(() => {
      const navigation = scope.pluginNavigation
      controller.setSpeechSettings(() => navigation.openBundle(voiceBundle))
      return () => controller.setSpeechSettings(null)
    })
  })
  ctx.inject(['remote.speech'], scope => {
    scope.effect(() => observeSpeech(scope.remote, controller))
  })
}
