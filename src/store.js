import { STATE_VERSION, isNoiseQuestion, newTopicTitle } from './core.js'

const PREFIX = 'ask-graph'
// Bump when the default auto-layout changes, so stale dragged coordinates from
// an older layout direction do not keep the graph in the old shape.
const LAYOUT_VERSION = 2

export function storageKey(scopeKey) {
  return `${PREFIX}:v${STATE_VERSION}:${scopeKey || 'global'}`
}

export function defaultState() {
  return {
    version: STATE_VERSION,
    layoutVersion: LAYOUT_VERSION,
    topics: [],
    nodes: [],
    pendingTopics: {},
    positions: {},
    topicPositions: {},
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanTopic(topic) {
  if (!isObject(topic) || typeof topic.id !== 'string' || typeof topic.title !== 'string') return null
  return {
    id: topic.id,
    title: topic.title,
    createdAt: typeof topic.createdAt === 'number' ? topic.createdAt : 0,
    updatedAt: typeof topic.updatedAt === 'number' ? topic.updatedAt : 0,
    summary: typeof topic.summary === 'string' ? topic.summary : '',
    summaryAt: typeof topic.summaryAt === 'number' ? topic.summaryAt : 0,
    summarySource: topic.summarySource === 'ai' ? 'ai' : 'local',
    keywords: Array.isArray(topic.keywords)
      ? topic.keywords.filter((word) => typeof word === 'string' && word.length > 0).slice(0, 8)
      : [],
    ...(topic.kind === 'inbox' ? { kind: 'inbox' } : {}),
    nodeIds: Array.isArray(topic.nodeIds) ? topic.nodeIds.filter((id) => typeof id === 'string') : [],
  }
}

function stripLegacyPlaceholders(text) {
  return text
    .replace(/（本轮没有文字回复，DSH 执行了工具调用：[^）]*）/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function cleanImages(input) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const item of input) {
    if (!isObject(item) || typeof item.attachmentId !== 'string' || !item.attachmentId.startsWith('sha256:')) continue
    if (seen.has(item.attachmentId)) continue
    seen.add(item.attachmentId)
    out.push({
      attachmentId: item.attachmentId,
      mediaType: IMAGE_MEDIA.has(item.mediaType) ? item.mediaType : 'image/png',
      name: typeof item.name === 'string' ? item.name.slice(0, 120) : undefined,
      width: Number.isFinite(item.width) ? item.width : undefined,
      height: Number.isFinite(item.height) ? item.height : undefined,
      bytes: Number.isFinite(item.bytes) ? item.bytes : undefined,
    })
    if (out.length >= 30) break
  }
  return out
}

function cleanNode(node) {
  if (!isObject(node) || typeof node.id !== 'string' || typeof node.sessionId !== 'string') return null
  if (typeof node.question !== 'string' || typeof node.topicId !== 'string') return null
  return {
    id: node.id,
    sessionId: node.sessionId,
    topicId: node.topicId,
    question: node.question,
    answer: typeof node.answer === 'string' ? stripLegacyPlaceholders(node.answer) : '',
    at: typeof node.at === 'number' ? node.at : 0,
    userSeq: typeof node.userSeq === 'number' ? node.userSeq : undefined,
    assistantSeq: typeof node.assistantSeq === 'number' ? node.assistantSeq : undefined,
    status: node.status === 'done' || node.status === 'pending' ? node.status : 'no-reply',
    source: node.source === 'asked' ? 'asked' : 'auto',
    assignment: node.assignment === 'manual' ? 'manual' : 'auto',
    assignmentReason: typeof node.assignmentReason === 'string' ? node.assignmentReason : undefined,
    score: typeof node.score === 'number' ? node.score : undefined,
    images: cleanImages(node.images),
  }
}

function cleanPositions(input) {
  if (!isObject(input)) return {}
  const out = {}
  for (const [id, positions] of Object.entries(input)) {
    if (!isObject(positions)) continue
    const cleaned = {}
    for (const [nodeId, pos] of Object.entries(positions)) {
      if (isObject(pos) && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        cleaned[nodeId] = { x: pos.x, y: pos.y }
      }
    }
    if (Object.keys(cleaned).length > 0) out[id] = cleaned
  }
  return out
}

function cleanTopicPositions(input) {
  if (!isObject(input)) return {}
  const out = {}
  for (const [id, pos] of Object.entries(input)) {
    if (isObject(pos) && Number.isFinite(pos.x) && Number.isFinite(pos.y)) out[id] = { x: pos.x, y: pos.y }
  }
  return out
}

/** Accept only the current schema; any malformed field falls back safely. */
export function normalizeState(raw) {
  if (!isObject(raw) || raw.version !== STATE_VERSION) return defaultState()
  const topics = []
  const topicIds = new Set()
  for (const item of Array.isArray(raw.topics) ? raw.topics : []) {
    const topic = cleanTopic(item)
    if (topic && !topicIds.has(topic.id)) {
      topicIds.add(topic.id)
      topics.push(topic)
    }
  }
  const nodes = []
  const nodeIds = new Set()
  for (const item of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const node = cleanNode(item)
    if (!node || nodeIds.has(node.id) || !topicIds.has(node.topicId)) continue
    if (isNoiseQuestion(node.question)) continue
    nodeIds.add(node.id)
    nodes.push(node)
  }
  // Drop topics that only held injected (non-question) messages.
  const usedTopicIds = new Set(nodes.map((node) => node.topicId))
  const usedTopics = topics
    .filter((topic) => usedTopicIds.has(topic.id))
    .map((topic) => {
      if (!isNoiseQuestion(topic.title)) return topic
      const first = nodes
        .filter((node) => node.topicId === topic.id)
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))[0]
      return first ? { ...topic, title: newTopicTitle(first.question) } : topic
    })
  const pendingTopics = {}
  for (const [sessionId, topicId] of Object.entries(isObject(raw.pendingTopics) ? raw.pendingTopics : {})) {
    if (typeof topicId === 'string' && usedTopicIds.has(topicId)) pendingTopics[sessionId] = topicId
  }
  const keepPositions = raw.layoutVersion === LAYOUT_VERSION
  return {
    version: STATE_VERSION,
    layoutVersion: LAYOUT_VERSION,
    topics: usedTopics,
    nodes,
    pendingTopics,
    positions: keepPositions ? cleanPositions(raw.positions) : {},
    topicPositions: keepPositions ? cleanTopicPositions(raw.topicPositions) : {},
  }
}

export function parseState(text) {
  try {
    return normalizeState(JSON.parse(text))
  } catch {
    return defaultState()
  }
}

export function serializeState(state) {
  return JSON.stringify(state)
}

export function loadState(scopeKey) {
  try {
    const text = globalThis.localStorage?.getItem(storageKey(scopeKey))
    if (!text) return defaultState()
    const parsed = JSON.parse(text)
    if (!isObject(parsed) || parsed.version !== STATE_VERSION) {
      backupCorrupt(scopeKey, text)
      return defaultState()
    }
    return normalizeState(parsed)
  } catch {
    return defaultState()
  }
}

function backupCorrupt(scopeKey, text) {
  try {
    const key = `${storageKey(scopeKey)}:corrupt:${Date.now()}`
    globalThis.localStorage?.setItem(key, text)
  } catch {
    // Quota or privacy mode: the in-memory state still works.
  }
}

/** @returns {{ok: boolean, error?: string}} */
export function saveState(scopeKey, state) {
  try {
    globalThis.localStorage?.setItem(storageKey(scopeKey), serializeState(state))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'localStorage 写入失败' }
  }
}

/** 300ms debounced writer; call `flush` when the panel unmounts. */
export function createSaver(scopeKey, delay = 300) {
  let timer
  let last = null
  const saver = (state) => {
    last = state
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      saver.result = saveState(scopeKey, last)
    }, delay)
  }
  saver.flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (last) saver.result = saveState(scopeKey, last)
  }
  saver.result = { ok: true }
  return saver
}
