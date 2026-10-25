/**
 * Pure logic for 提问图谱: event pairing, topic routing, graph edges, local
 * summary. No React, no DOM, no imports — unit-testable under Node.
 */

export const STATE_VERSION = 1

/**
 * Topic routing thresholds. They are exported so tests and future tuning can
 * lock the exact numbers instead of rediscovering them from behaviour.
 */
export const SIM_STRONG = 0.38
export const SIM_WEAK = 0.26
export const SIM_PRIOR = 0.22
export const SIM_MARGIN = 0.05
export const FOLLOWUP_WINDOW = 30 * 60_000
export const TOPIC_DECAY_DAYS = 120
export const TOPIC_WEIGHT_FLOOR = 0.35
export const RECLUSTER_LINK = 0.3
export const RECLUSTER_MERGE = 0.32

/**
 * Words that are too common to prove two questions share a feature. A shared
 * title token outside this set gets a similarity floor in `rankTopics`.
 */
const GENERIC_TITLE_TOKENS = new Set([
  '节点', '代码', '文件', '项目', '功能', '问题', '配置', '数据', '系统', '页面', '组件',
  '样式', '布局', '图', '线', '边', '值', '参数', '接口', '服务', '模块', '方案', '方式',
  '方法', '内容', '信息', '文档', '测试', '版本', '环境', '流程', '逻辑', '状态', '结果',
])

/** `[专题: 标题]` prefix written into the native composer draft. */
const TOPIC_MARKER = /^\s*\[专题\s*[:：]\s*([^\]\n]{1,120})\]\s*\n?/

export function markerTitle(text) {
  const match = String(text ?? '').match(TOPIC_MARKER)
  return match ? match[1].trim() : ''
}

export function stripMarker(text) {
  return String(text ?? '').replace(TOPIC_MARKER, '').trim()
}

/** Flatten PromptContentPart[] / message content into display text. */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!content) return ''
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') parts.push(block)
      else if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    if (Array.isArray(content.content)) return textOf(content.content)
  }
  return ''
}

function messageOfEntry(entry) {
  if (!entry || entry.type !== 'event') return null
  const event = entry.event ?? entry
  if (!event || typeof event.type !== 'string') return null
  const data = event.data ?? {}
  const message = data.message && typeof data.message === 'object' ? data.message : data
  return {
    type: event.type,
    seq: typeof event.seq === 'number' ? event.seq : undefined,
    time: typeof event.time === 'number' ? event.time : undefined,
    id: typeof message.id === 'string' ? message.id : undefined,
    role: typeof message.role === 'string' ? message.role : undefined,
    sourceKind: typeof message.source?.kind === 'string' ? message.source.kind : undefined,
    content: message.content,
  }
}

/**
 * A turn that only calls tools might still carry a real answer in its plan
 * payload (for example `exit_plan_mode`). Surface that plan text; never invent
 * placeholder lines about tool calls — the answer stays empty otherwise.
 */
function toolFallback(content) {
  const blocks = Array.isArray(content) ? content : []
  const calls = blocks.filter((block) => block && block.type === 'tool-call' && typeof block.name === 'string')
  const planCall = calls.find((block) => block.name === 'exit_plan_mode')
  if (!planCall) return ''
  try {
    const args = typeof planCall.arguments === 'string' ? JSON.parse(planCall.arguments) : planCall.arguments
    if (args && typeof args.plan === 'string' && args.plan.trim()) return args.plan.trim()
  } catch {
    // Ignore malformed plan payloads.
  }
  return ''
}

function entrySeq(entry) {
  const seq = entry?.event?.seq
  return typeof seq === 'number' ? seq : Number.MAX_SAFE_INTEGER
}

function normalizeImageRef(value) {
  if (!value || typeof value !== 'object') return null
  const attachment = value.attachment && typeof value.attachment === 'object' ? value.attachment : value
  const attachmentId = attachment.attachmentId
  if (typeof attachmentId !== 'string' || !attachmentId.startsWith('sha256:')) return null
  return {
    attachmentId,
    mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : 'image/png',
    name: typeof attachment.name === 'string' ? attachment.name : undefined,
    width: Number.isFinite(attachment.width) ? attachment.width : undefined,
    height: Number.isFinite(attachment.height) ? attachment.height : undefined,
    bytes: Number.isFinite(attachment.bytes) ? attachment.bytes : undefined,
  }
}

/** Collect durable image refs from any nested message content. */
function imageRefsOf(value, depth = 0, seen = new WeakSet(), out = []) {
  if (!value || typeof value !== 'object' || depth > 8 || out.length >= 30) return out
  if (seen.has(value)) return out
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) imageRefsOf(item, depth + 1, seen, out)
    return out
  }
  if (value.type === 'image') {
    const ref = normalizeImageRef(value)
    if (ref) out.push(ref)
    return out
  }
  for (const key of ['content', 'message', 'blocks', 'result']) {
    if (value[key]) imageRefsOf(value[key], depth + 1, seen, out)
  }
  return out
}

function mergeImages(left, right) {
  const merged = []
  const seen = new Set()
  for (const item of [...(left ?? []), ...(right ?? [])]) {
    if (!item || typeof item.attachmentId !== 'string' || seen.has(item.attachmentId)) continue
    seen.add(item.attachmentId)
    merged.push(item)
    if (merged.length >= 30) break
  }
  return merged
}

function finalize(pending, status) {
  return {
    ...pending,
    images: pending.images ?? [],
    status,
    answer: pending.answer || '',
  }
}

/**
 * Pair user/assistant events of one session into dialog nodes, oldest first.
 * Assistant text from multiple steps of one turn is joined until the next user
 * message. Tool calls, reasoning and usage are ignored.
 */
export function pairEntries(entries, sessionId) {
  const nodes = []
  let pending = null
  let fallback = 0
  // Windows may arrive newest-first; ordering by seq keeps pairing stable.
  const ordered = [...(entries ?? [])].sort((a, b) => entrySeq(a) - entrySeq(b))

  for (const entry of ordered) {
    const message = messageOfEntry(entry)
    if (!message) continue

    if (message.type === 'user/message') {
      // Runtime context, time context, skill catalogs, approvals and job
      // notices are user-role messages too; only real user input is a question.
      if (message.sourceKind && message.sourceKind !== 'user') continue
      if (pending) nodes.push(finalize(pending, pending.status === 'done' ? 'done' : 'no-reply'))
      const raw = textOf(message.content)
      const question = stripMarker(raw)
      const images = imageRefsOf(message.content)
      if (!question && images.length === 0) {
        pending = null
        continue
      }
      const seq = message.seq ?? message.id ?? `m${fallback++}`
      pending = {
        id: `${sessionId}:${seq}`,
        sessionId,
        question: question || '（图片提问）',
        answer: '',
        at: message.time ?? Date.now(),
        userSeq: message.seq,
        assistantSeq: undefined,
        status: 'pending',
        images,
      }
      continue
    }

    if (message.type === 'assistant/message' && pending) {
      const answer = textOf(message.content).trim() || toolFallback(message.content)
      const images = imageRefsOf(message.content)
      if (!answer && images.length === 0) continue
      if (answer) pending.answer = pending.answer ? `${pending.answer}\n\n${answer}` : answer
      if (images.length > 0) pending.images = mergeImages(pending.images, images)
      pending.assistantSeq = message.seq
      pending.status = 'done'
    }
  }

  if (pending) nodes.push(finalize(pending, pending.status === 'done' ? 'done' : 'no-reply'))
  return nodes
}

/** All user questions in a session window, for marker-only fallbacks. */
export function userTexts(entries) {
  const out = []
  for (const entry of entries ?? []) {
    const message = messageOfEntry(entry)
    if (message?.type === 'user/message' && (!message.sourceKind || message.sourceKind === 'user')) {
      const text = textOf(message.content)
      if (text) out.push({ text, seq: message.seq, time: message.time })
    }
  }
  return out
}

/**
 * Messages DSH injects into the conversation (runtime context, time sampling,
 * skill catalogs, approvals, job notices) must never become question nodes.
 * These prefixes are only used to clean state written by older versions; new
 * nodes are filtered by `source.kind` in `pairEntries`.
 */
const NOISE_PREFIXES = [
  'Current runtime context.',
  'The approval policy changed from',
  'Time sampled while preparing',
  'Browser time zone for this request:',
  'A skill is a reusable set of task-specific instructions',
  '<system-reminder>',
  'background job ',
  'Current working directory:',
  'Current DSH file policy:',
  'Current DeepSeek Harness implementation checkout:',
  'You are an AI agent powered by DeepSeek Harness',
  'dsh-graph 是把工作组织成「目标看板」的插件',
  '你是「提问图谱」的语义整理助手',
]

export function isNoiseQuestion(question) {
  const text = String(question ?? '').trim()
  if (!text) return true
  return NOISE_PREFIXES.some((prefix) => text.startsWith(prefix))
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'your', 'you', 'are', 'was', 'were',
  'can', 'could', 'would', 'should', 'about', 'into', 'then', 'than', 'them', 'they', 'their', 'there', 'what',
  'when', 'where', 'which', 'while', 'how', 'why', 'not', 'but', 'all', 'any', 'our', 'out', 'use', 'using',
  'code', 'file', 'files', 'function', 'implement', 'fix', 'add', 'issue', 'problem', 'help', 'please', 'now',
  'need', 'make', 'test', 'tests', 'still', 'just', 'also', 'more', 'some', 'does', 'like', 'want',
  '请', '帮我', '帮忙', '麻烦', '一下', '一个', '这个', '那个', '这些', '那些', '这里', '上面', '刚才', '可以',
  '需要', '如何', '怎么', '怎样', '什么', '以及', '并且', '然后', '现在', '继续', '还有', '问题', '功能', '代码',
  '文件', '实现', '修改', '看看', '还是', '就是', '不是', '没有', '已经', '我们', '你们', '他们', '它们', '因为',
  '所以', '如果', '但是', '同样', '此类', '那个', '再', '它',
])

const QUESTION_FILLERS =
  /(?:请问|帮我|帮忙|麻烦|能不能|能否|可以|怎么|怎样|如何|为什么|为何|什么|哪些|哪个|是否|需要|应该|要不要|有没有|一下|一个|这个|那个|这些|那些|我们|你们|他们|以及|还有|就是|然后|如果|那么|因为|所以|但是|而且|或者|之前|之后|以后|已经|目前|现在|这里|上面|刚才|继续|问题|功能|实现|修改|看看|还是|不是|没有|失败|报错|错误|异常|解决|排查|处理|情况|时候|办法|方法|相关|进行)/g

function cleanText(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/```/g, ' ')
    .replace(/`/g, ' ')
    // Filler phrases are removed before CJK bigramming so that "怎么处理"
    // cannot leave junk bigrams such as "么处" behind.
    .replace(/(过期|完成|结束)后/g, '$1')
    .replace(QUESTION_FILLERS, ' ')
    // CamelCase identifiers carry meaning: `parseConfig` -> `parse config`.
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .slice(0, 1600)
}

/** CJK bigrams + Latin words; returns a Set. */
export function tokenize(text) {
  const cleaned = cleanText(text)
  const tokens = new Set()
  for (const word of cleaned.match(/[a-z0-9_]{2,}/g) ?? []) {
    if (!STOPWORDS.has(word)) tokens.add(word)
  }
  const cjkRuns = cleaned.match(/[\u3400-\u9fff]{2,}/g) ?? []
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i += 1) {
      const gram = run.slice(i, i + 2)
      if (!STOPWORDS.has(gram)) tokens.add(gram)
    }
  }
  return tokens
}

function buildCorpus(state) {
  const nodes = state.nodes ?? []
  const df = new Map()
  const nodeTokens = new Map()
  const answerTokens = new Map()
  for (const node of nodes) {
    const questionTokens = tokenize(node.question)
    nodeTokens.set(node.id, questionTokens)
    for (const token of questionTokens) df.set(token, (df.get(token) ?? 0) + 1)
    if (node.answer) {
      const answers = tokenize(String(node.answer).slice(0, 1200))
      answerTokens.set(node.id, answers)
      for (const token of answers) df.set(token, (df.get(token) ?? 0) + 1)
    }
  }
  return { n: nodes.length, df, nodeTokens, answerTokens }
}

function idf(token, corpus) {
  return Math.log(1 + (corpus.n + 1) / (1 + (corpus.df.get(token) ?? 0)))
}

function addVector(target, tokens, weight, corpus) {
  for (const token of tokens) target.set(token, (target.get(token) ?? 0) + weight * idf(token, corpus))
}

function normalizeVector(vector) {
  let sum = 0
  for (const value of vector.values()) sum += value * value
  if (sum <= 0) return vector
  const length = Math.sqrt(sum)
  for (const [token, value] of vector) vector.set(token, value / length)
  return vector
}

function questionVector(tokens, corpus) {
  const vector = new Map()
  addVector(vector, tokens, 1, corpus)
  return normalizeVector(vector)
}

export function cosine(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let sum = 0
  for (const [token, value] of small) {
    const other = large.get(token)
    if (other) sum += value * other
  }
  return sum
}

/**
 * Long-term topic profile: every node contributes; even a node repeated months
 * later keeps at least TOPIC_WEIGHT_FLOOR of its weight. That is what makes a
 * topic survive long gaps between questions.
 */
export function topicProfile(topic, state, corpus, now = Date.now()) {
  const vector = new Map()
  addVector(vector, tokenize(topic.title), 3, corpus)
  for (const keyword of topic.keywords ?? []) addVector(vector, tokenize(keyword), 2, corpus)
  // AI summaries carry the feature's vocabulary even when the individual
  // questions used different wording, so they participate in routing too.
  if (topic.summary) addVector(vector, tokenize(topic.summary), 1.2, corpus)
  for (const node of state.nodes ?? []) {
    if (node.topicId !== topic.id) continue
    const ageDays = Math.max(0, now - (node.at ?? 0)) / 86_400_000
    const weight = TOPIC_WEIGHT_FLOOR + (1 - TOPIC_WEIGHT_FLOOR) * Math.exp(-ageDays / TOPIC_DECAY_DAYS)
    addVector(vector, corpus.nodeTokens.get(node.id) ?? tokenize(node.question), 0.7 * weight, corpus)
    const answers = corpus.answerTokens.get(node.id)
    if (answers) addVector(vector, answers, 0.3 * weight, corpus)
  }
  return normalizeVector(vector)
}

/**
 * Shared *specific* words in two questions are stronger evidence of the same
 * feature than a diluted bag-of-bigrams cosine. Returns a similarity floor.
 */
function titleTokenBonus(titleA, titleB) {
  const left = new Set(tokenize(titleA))
  let shared = 0
  for (const token of tokenize(titleB)) {
    if (token.length < 2 || GENERIC_TITLE_TOKENS.has(token)) continue
    if (left.has(token)) shared += 1
  }
  return shared > 0 ? Math.min(0.46, 0.3 + 0.05 * (shared - 1)) : 0
}

/** Rank every topic for a question, best first. Time gap never filters a topic. */
export function rankTopics(question, state, now = Date.now(), corpus = buildCorpus(state)) {
  const tokens = tokenize(question)
  if (tokens.size === 0) return []
  const vector = questionVector(tokens, corpus)
  const ranked = []
  for (const topic of state.topics ?? []) {
    const topicVector = topicProfile(topic, state, corpus, now)
    if (topicVector.size === 0) continue
    const sim = Math.max(cosine(vector, topicVector), titleTokenBonus(topic.title, question))
    ranked.push({ topicId: topic.id, sim })
  }
  return ranked.sort((a, b) => b.sim - a.sim || a.topicId.localeCompare(b.topicId))
}

/** Backwards-compatible similarity lookup used by tests and callers. */
export function classifyQuestion(question, state, now = Date.now()) {
  const best = rankTopics(question, state, now)[0]
  if (!best || best.sim < SIM_WEAK) return null
  return { topicId: best.topicId, score: best.sim }
}

const CONTINUATION = /^(继续|接着|还有|再|然后|这个|那个|它|这里|上面|刚才|那|改一下|修一下|优化一下|然后呢)/u

export function analyzeQuestion(text) {
  const raw = stripMarker(text)
  const compact = raw.replace(/\s+/g, '')
  const tokens = tokenize(raw)
  return {
    text: raw,
    tokens,
    short: Array.from(compact).length <= 20 || tokens.size <= 3,
    anaphoric: CONTINUATION.test(compact),
  }
}

export function lastNodeInSession(state, sessionId) {
  let latest
  for (const node of state.nodes ?? []) {
    if (node.sessionId !== sessionId) continue
    if (!latest || (node.at ?? 0) > (latest.at ?? 0)) latest = node
  }
  return latest
}

export function lastTopicInSession(state, sessionId) {
  return lastNodeInSession(state, sessionId)?.topicId
}

/** Topics touched by one session, oldest first; used by tests and diagnostics. */
export function sessionTopics(state, sessionId) {
  const seen = []
  for (const node of [...(state.nodes ?? [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    if (node.sessionId !== sessionId || !node.topicId) continue
    if (seen[seen.length - 1] !== node.topicId) seen.push(node.topicId)
  }
  return seen
}

export function smartTitle(question) {
  const source = stripMarker(question).replace(/^[\s#>*\-—:：,，.。!！?？、;；]+/, '').replace(/\s+/g, ' ').trim()
  const first = (source.split(/[。！？!?\n]/)[0] ?? source).trim() || source
  const stripped = first.replace(/^(请|帮我|帮忙|麻烦|能不能|可以|如何|怎么|怎样|我想|我想要|需要|现在|然后|再)+/u, '').trim()
  const text = stripped || first
  const chars = Array.from(text)
  return (chars.length > 24 ? `${chars.slice(0, 24).join('')}…` : chars.join('')) || '未命名专题'
}

export function newTopicTitle(question) {
  return smartTitle(question)
}

export function keywordsFor(text, state, limit = 5) {
  const corpus = buildCorpus(state)
  return [...tokenize(text)]
    .sort((a, b) => idf(b, corpus) - idf(a, corpus) || b.length - a.length || a.localeCompare(b))
    .slice(0, limit)
}

/**
 * Decide where one question belongs. Time is deliberately not a boundary here:
 * a feature can come back after days or months and still match its topic.
 */
export function decideTopic(question, state, { sessionId, now = Date.now(), previousNode, corpus } = {}) {
  const analysis = analyzeQuestion(question)
  const previous = previousNode ?? (sessionId ? lastNodeInSession(state, sessionId) : undefined)
  const ranker = corpus ?? buildCorpus(state)
  const ranked = rankTopics(analysis.text, state, now, ranker)
  const best = ranked[0]
  const second = ranked[1]
  const priorId = previous?.topicId ?? (sessionId ? lastTopicInSession(state, sessionId) : undefined)
  const prior = priorId ? ranked.find((item) => item.topicId === priorId) : undefined
  const priorSim = prior?.sim ?? 0

  // A short follow-up continues the previous topic, but only when it actually
  // shares vocabulary with it. Length alone is not enough: "那怎么办？" after a
  // layout question should not glue an unrelated login question to that topic.
  if (
    previous?.topicId &&
    now - (previous.at ?? 0) <= FOLLOWUP_WINDOW &&
    (analysis.anaphoric || (analysis.short && priorSim >= SIM_PRIOR))
  ) {
    return { topicId: previous.topicId, reason: 'continuity', score: priorSim }
  }

  if (best && best.sim >= SIM_STRONG && (!second || best.sim - second.sim >= SIM_MARGIN)) {
    return { topicId: best.topicId, reason: 'similarity', score: best.sim }
  }
  // Returning to a long-running session after weeks/months: the last topic is a
  // weak prior with no expiry, but an explicit stronger match still wins above.
  if (
    priorId &&
    (analysis.anaphoric || analysis.tokens.size <= 1 || priorSim >= SIM_PRIOR) &&
    (!best || (best.sim < SIM_STRONG && priorSim >= best.sim - SIM_MARGIN))
  ) {
    return { topicId: priorId, reason: 'revisit', score: priorSim }
  }
  if (best && best.sim >= SIM_WEAK) {
    return { topicId: best.topicId, reason: 'weak-similarity', score: best.sim }
  }
  if (analysis.tokens.size < 2) return { reason: 'inbox', score: best?.sim ?? 0 }
  return {
    reason: 'new',
    title: smartTitle(analysis.text),
    keywords: keywordsFor(analysis.text, state),
    score: best?.sim ?? 0,
  }
}

function uniqueTopicId(state, now) {
  let index = (state.topics?.length ?? 0) + 1
  let id = `t_${now}_${index}`
  const taken = new Set((state.topics ?? []).map((topic) => topic.id))
  while (taken.has(id)) {
    index += 1
    id = `t_${now}_${index}`
  }
  return id
}

function findTopicByTitle(state, title) {
  const normalized = String(title ?? '').trim()
  return (state.topics ?? []).find((topic) => topic.title === normalized)
}

function createTopicMut(draft, title, now, keywords = []) {
  const topic = {
    id: uniqueTopicId(draft, now),
    title: title || '未命名专题',
    createdAt: now,
    updatedAt: now,
    summary: '',
    summaryAt: 0,
    summarySource: 'local',
    keywords: Array.isArray(keywords) ? keywords : [],
    nodeIds: [],
  }
  draft.topics.push(topic)
  return topic
}

function ensureInboxMut(draft, now) {
  const existing = (draft.topics ?? []).find((topic) => topic.kind === 'inbox')
  if (existing) return existing
  const inbox = createTopicMut(draft, '待归类', now, [])
  inbox.kind = 'inbox'
  return inbox
}

function routeTopicMut(draft, node, now, corpus) {
  const pendingTopicId = draft.pendingTopics?.[node.sessionId]
  if (pendingTopicId && draft.topics.some((topic) => topic.id === pendingTopicId)) {
    delete draft.pendingTopics[node.sessionId]
    return { topicId: pendingTopicId, assignment: 'auto', reason: 'pending' }
  }

  const marked = markerTitle(node.question)
  if (marked) {
    const existing = findTopicByTitle(draft, marked)
    const topic = existing ?? createTopicMut(draft, marked, now, keywordsFor(marked, draft))
    return { topicId: topic.id, assignment: 'auto', reason: 'marker' }
  }

  const decision = decideTopic(node.question, draft, { sessionId: node.sessionId, now, corpus })
  if (decision.topicId) {
    return { topicId: decision.topicId, assignment: 'auto', reason: decision.reason, score: decision.score }
  }
  if (decision.reason === 'inbox') {
    const inbox = ensureInboxMut(draft, now)
    return { topicId: inbox.id, assignment: 'auto', reason: 'inbox', score: 0 }
  }
  const topic = createTopicMut(draft, decision.title, now, decision.keywords)
  return { topicId: topic.id, assignment: 'auto', reason: 'new', score: decision.score ?? 0 }
}

function recomputeTopics(draft) {
  for (const topic of draft.topics) {
    const mine = draft.nodes.filter((node) => node.topicId === topic.id)
    topic.nodeIds = mine.map((node) => node.id)
    topic.updatedAt = Math.max(topic.updatedAt ?? 0, ...mine.map((node) => node.at ?? 0), topic.createdAt ?? 0)
  }
  return draft
}

/**
 * Merge emitted session nodes into state. New nodes are routed to a topic and
 * existing nodes only refresh answer/status (never re-classified).
 */
export function ingestNodes(state, incoming, now = Date.now()) {
  const draft = {
    ...state,
    topics: (state.topics ?? []).map((topic) => ({ ...topic })),
    nodes: (state.nodes ?? []).map((node) => ({ ...node })),
    pendingTopics: { ...(state.pendingTopics ?? {}) },
  }
  const byId = new Map(draft.nodes.map((node) => [node.id, node]))
  const corpus = buildCorpus(draft)

  for (const raw of incoming ?? []) {
    if (!raw || !raw.id || !raw.sessionId || !raw.question) continue
    const existing = byId.get(raw.id)
    if (existing) {
      existing.answer = raw.answer || existing.answer
      existing.assistantSeq = raw.assistantSeq ?? existing.assistantSeq
      existing.status = raw.status ?? existing.status
      existing.at = existing.at ?? raw.at
      if (raw.images?.length) existing.images = mergeImages(existing.images, raw.images)
      continue
    }

    const routed = routeTopicMut(draft, raw, now, corpus)
    const node = {
      ...raw,
      topicId: routed.topicId,
      assignment: routed.assignment,
      assignmentReason: routed.reason,
      score: routed.score,
      answer: raw.answer ?? '',
      images: mergeImages([], raw.images),
    }
    draft.nodes.push(node)
    byId.set(node.id, node)
    const tokens = tokenize(node.question)
    corpus.nodeTokens.set(node.id, tokens)
    for (const token of tokens) corpus.df.set(token, (corpus.df.get(token) ?? 0) + 1)
    corpus.n += 1
    if (node.answer) corpus.answerTokens.set(node.id, tokenize(String(node.answer).slice(0, 1200)))
  }

  return recomputeTopics(draft)
}

function clusterProfile(cluster, corpus) {
  const vector = new Map()
  addVector(vector, tokenize(cluster.title), 3, corpus)
  for (const keyword of cluster.keywords ?? []) addVector(vector, tokenize(keyword), 2, corpus)
  for (const node of cluster.nodes) addVector(vector, corpus.nodeTokens.get(node.id) ?? [], 1, corpus)
  return normalizeVector(vector)
}

function mergeSimilarClusters(clusters, corpus) {
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < clusters.length; i += 1) {
      if (clusters[i].anchored) continue
      for (let j = i + 1; j < clusters.length; j += 1) {
        if (clusters[j].anchored) continue
        const sim = Math.max(
          cosine(clusterProfile(clusters[i], corpus), clusterProfile(clusters[j], corpus)),
          titleTokenBonus(clusters[i].title, clusters[j].title),
        )
        if (sim >= RECLUSTER_MERGE) {
          clusters[i].nodes.push(...clusters[j].nodes)
          clusters[i].keywords = [...new Set([...(clusters[i].keywords ?? []), ...(clusters[j].keywords ?? [])])]
          clusters.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }
  return clusters
}

function topicOverlap(cluster, topic, state) {
  const members = new Set(cluster.nodes.map((node) => node.id))
  const old = (state.nodes ?? []).filter((node) => node.topicId === topic.id)
  if (members.size === 0 || old.length === 0) return 0
  let shared = 0
  for (const node of old) if (members.has(node.id)) shared += 1
  return shared / Math.min(members.size, old.length)
}

function nextTopicId(taken, now) {
  let index = taken.size + 1
  let id = `t_${now}_${index}`
  while (taken.has(id)) {
    index += 1
    id = `t_${now}_${index}`
  }
  taken.add(id)
  return id
}

/**
 * Rebuild topic assignment globally. Manual moves are anchors and never change.
 * Auto nodes are clustered from scratch by similarity, then clusters are mapped
 * back onto existing topic ids where the membership overlaps enough, so titles
 * and summaries survive a reorganization when possible.
 */
export function reclusterState(state) {
  const topics = state.topics ?? []
  const nodes = state.nodes ?? []
  const corpus = buildCorpus(state)
  const topicById = new Map(topics.map((topic) => [topic.id, topic]))
  const takenIds = new Set(topics.map((topic) => topic.id))
  const clusters = []

  const manualByTopic = new Map()
  for (const node of nodes) {
    if (node.assignment !== 'manual') continue
    const bucket = manualByTopic.get(node.topicId) ?? []
    bucket.push(node)
    manualByTopic.set(node.topicId, bucket)
  }
  for (const [topicId, members] of manualByTopic) {
    const topic = topicById.get(topicId)
    clusters.push({
      anchored: true,
      topicId,
      title: topic?.title ?? '未命名专题',
      keywords: topic?.keywords ?? [],
      nodes: members,
    })
  }

  const shortNodes = []
  const autoNodes = nodes
    .filter((node) => node.assignment !== 'manual')
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || String(a.id).localeCompare(String(b.id)))
  for (const node of autoNodes) {
    const analysis = analyzeQuestion(node.question)
    if (analysis.tokens.size < 2) {
      shortNodes.push(node)
      continue
    }
    const nodeVector = questionVector(analysis.tokens, corpus)
    let best = null
    for (const cluster of clusters) {
      const sim = Math.max(cosine(nodeVector, clusterProfile(cluster, corpus)), titleTokenBonus(cluster.title, analysis.text))
      if (!best || sim > best.sim) best = { cluster, sim }
    }
    if (best && best.sim >= RECLUSTER_LINK) best.cluster.nodes.push(node)
    else clusters.push({ anchored: false, title: smartTitle(analysis.text), keywords: keywordsFor(analysis.text, state), nodes: [node] })
  }

  mergeSimilarClusters(clusters, corpus)

  const newTopics = []
  const usedIds = new Set()
  const mapping = new Map()
  const put = (topic, clusterNodes) => {
    newTopics.push({ ...topic, nodeIds: clusterNodes.map((node) => node.id) })
    usedIds.add(topic.id)
    for (const node of clusterNodes) mapping.set(node.id, topic.id)
  }

  for (const cluster of clusters) {
    if (cluster.anchored) {
      const topic = topicById.get(cluster.topicId)
      if (topic) put(topic, cluster.nodes)
      continue
    }
    let bestTopic = null
    let bestScore = 0
    for (const topic of topics) {
      if (usedIds.has(topic.id) || topic.kind === 'inbox' || manualByTopic.has(topic.id)) continue
      const score = topicOverlap(cluster, topic, state)
      if (score > bestScore) {
        bestScore = score
        bestTopic = topic
      }
    }
    if (bestTopic && bestScore >= 0.5) {
      const memberIds = new Set(cluster.nodes.map((node) => node.id))
      const extraSummaries = []
      let summaryAt = bestTopic.summaryAt ?? 0
      let summarySource = bestTopic.summarySource === 'ai' ? 'ai' : 'local'
      for (const topic of topics) {
        if (topic.id === bestTopic.id || usedIds.has(topic.id) || topic.kind === 'inbox' || !topic.summary) continue
        const contributes = (state.nodes ?? []).some((node) => memberIds.has(node.id) && node.topicId === topic.id)
        if (!contributes) continue
        extraSummaries.push(`### ${topic.title}\n${topic.summary}`)
        summaryAt = Math.max(summaryAt, topic.summaryAt ?? 0)
        if (topic.summarySource === 'ai') summarySource = 'ai'
      }
      put({
        ...bestTopic,
        title: cluster.title || bestTopic.title,
        keywords: cluster.keywords,
        summary: [bestTopic.summary, ...extraSummaries].filter(Boolean).join('\n\n'),
        summaryAt,
        summarySource,
      }, cluster.nodes)
      continue
    }
    const now = cluster.nodes[0]?.at ?? Date.now()
    put(
      {
        id: nextTopicId(takenIds, now),
        title: cluster.title || '未命名专题',
        createdAt: now,
        updatedAt: now,
        summary: '',
        summaryAt: 0,
        summarySource: 'local',
        keywords: cluster.keywords ?? [],
        nodeIds: [],
      },
      cluster.nodes,
    )
  }

  if (shortNodes.length > 0) {
    const now = shortNodes[0]?.at ?? Date.now()
    put(
      {
        id: nextTopicId(takenIds, now),
        kind: 'inbox',
        title: '待归类',
        createdAt: now,
        updatedAt: now,
        summary: '',
        summaryAt: 0,
        summarySource: 'local',
        keywords: [],
        nodeIds: [],
      },
      shortNodes,
    )
  }

  const nextNodes = nodes.map((node) => {
    const topicId = mapping.get(node.id)
    if (!topicId || topicId === node.topicId) return { ...node }
    const manual = node.assignment === 'manual'
    return {
      ...node,
      topicId,
      assignment: manual ? 'manual' : 'auto',
      assignmentReason: manual ? 'manual' : 'recluster',
    }
  })
  const next = recomputeTopics({ ...state, topics: newTopics, nodes: nextNodes })
  next.topics = next.topics.filter((topic) => topic.nodeIds.length > 0)
  return next
}

function nextSemanticTopicId(taken, now) {
  let index = taken.size + 1
  let id = `t_${now}_${index}`
  while (taken.has(id)) {
    index += 1
    id = `t_${now}_${index}`
  }
  taken.add(id)
  return id
}

/**
 * Apply a semantic grouping produced by DSH. Manual nodes stay where the user
 * put them; auto nodes omitted by the model move to the inbox instead of
 * silently staying in a topic that no longer represents them.
 */
export function applySemanticGroups(state, groups, now = Date.now()) {
  const nodes = state.nodes ?? []
  const topics = state.topics ?? []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const manualIds = new Set(nodes.filter((node) => node.assignment === 'manual').map((node) => node.id))
  const manualTopicIds = new Set(nodes.filter((node) => node.assignment === 'manual').map((node) => node.topicId))
  const oldAutoTopics = topics.filter((topic) => !manualTopicIds.has(topic.id) && topic.kind !== 'inbox')
  const autoTopicById = new Map(oldAutoTopics.map((topic) => [topic.id, topic]))
  const taken = new Set(topics.map((topic) => topic.id))
  const newTopics = []
  const assigned = new Set()

  // Manual containers are fixed; only their auto nodes may be regrouped.
  for (const topic of topics) {
    if (!manualTopicIds.has(topic.id)) continue
    newTopics.push({ ...topic, nodeIds: nodes.filter((node) => node.topicId === topic.id).map((node) => node.id) })
  }

  for (const group of groups) {
    const ids = [...new Set(group.nodeIds)].filter((id) => nodeById.has(id) && !manualIds.has(id) && !assigned.has(id))
    if (ids.length === 0) continue
    for (const id of ids) assigned.add(id)
    const groupNodes = ids
      .map((id) => nodeById.get(id))
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || String(a.id).localeCompare(String(b.id)))

    let bestId = null
    let bestCount = 0
    for (const topic of oldAutoTopics) {
      let count = 0
      for (const node of groupNodes) if (node.topicId === topic.id) count += 1
      if (count > bestCount) {
        bestCount = count
        bestId = topic.id
      }
    }

    const reuse = bestId && bestCount / groupNodes.length >= 0.5 && !newTopics.some((topic) => topic.id === bestId)
    if (reuse) {
      const old = autoTopicById.get(bestId)
      const others = oldAutoTopics.filter(
        (topic) => topic.id !== bestId && topic.summary && groupNodes.some((node) => node.topicId === topic.id),
      )
      const summary = [old.summary, ...others.map((topic) => `### ${topic.title}\n${topic.summary}`), group.summary]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 6000)
      newTopics.push({
        ...old,
        title: group.title || old.title,
        summary,
        summaryAt: Math.max(old.summaryAt ?? 0, ...others.map((topic) => topic.summaryAt ?? 0), group.summary ? now : 0),
        summarySource: group.summary ? 'ai' : old.summarySource ?? 'local',
        keywords: old.keywords?.length ? old.keywords : keywordsFor(group.title, state),
        nodeIds: groupNodes.map((node) => node.id),
      })
      continue
    }

    const contributing = oldAutoTopics.filter(
      (topic) => topic.summary && groupNodes.some((node) => node.topicId === topic.id),
    )
    const summary = [group.summary, ...contributing.map((topic) => `### ${topic.title}\n${topic.summary}`)]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 6000)
    newTopics.push({
      id: nextSemanticTopicId(taken, now),
      title: group.title || '未命名专题',
      createdAt: groupNodes[0]?.at ?? now,
      updatedAt: now,
      summary,
      summaryAt: summary ? now : 0,
      summarySource: group.summary ? 'ai' : 'local',
      keywords: keywordsFor(group.title, state),
      nodeIds: groupNodes.map((node) => node.id),
    })
  }

  const leftovers = nodes.filter((node) => node.assignment !== 'manual' && !assigned.has(node.id))
  if (leftovers.length > 0) {
    newTopics.push({
      id: nextSemanticTopicId(taken, now),
      kind: 'inbox',
      title: '待归类',
      createdAt: now,
      updatedAt: now,
      summary: '',
      summaryAt: 0,
      summarySource: 'local',
      keywords: [],
      nodeIds: leftovers.map((node) => node.id),
    })
  }

  const topicByNode = new Map()
  for (const topic of newTopics) for (const id of topic.nodeIds) topicByNode.set(id, topic.id)
  const nextNodes = nodes.map((node) => {
    if (manualIds.has(node.id)) return { ...node }
    const topicId = topicByNode.get(node.id) ?? node.topicId
    return {
      ...node,
      topicId,
      assignment: 'auto',
      assignmentReason: node.topicId === topicId ? node.assignmentReason : 'semantic',
    }
  })
  const next = recomputeTopics({ ...state, topics: newTopics, nodes: nextNodes })
  next.topics = next.topics.filter((topic) => topic.nodeIds.length > 0)
  return next
}

/** Apply a user-initiated move; manual assignment survives future auto runs. */
export function moveNode(state, nodeId, topicId) {
  const node = (state.nodes ?? []).find((item) => item.id === nodeId)
  if (!node) return state
  const topics = state.topics ?? []
  if (!topics.some((topic) => topic.id === topicId)) return state
  return recomputeTopics({
    ...state,
    topics: topics.map((topic) => ({ ...topic })),
    nodes: state.nodes.map((item) =>
      item.id === nodeId ? { ...item, topicId, assignment: 'manual', assignmentReason: 'manual' } : { ...item },
    ),
  })
}

export function removeNode(state, nodeId) {
  return recomputeTopics({
    ...state,
    topics: (state.topics ?? []).map((topic) => ({ ...topic })),
    nodes: (state.nodes ?? []).filter((node) => node.id !== nodeId),
  })
}

export function renameTopic(state, topicId, title) {
  const next = String(title ?? '').trim()
  if (!next) return state
  return {
    ...state,
    topics: (state.topics ?? []).map((topic) => (topic.id === topicId ? { ...topic, title: next } : topic)),
  }
}

/** Sort a topic's nodes by question time, oldest first. */
export function topicNodes(state, topicId) {
  return (state.nodes ?? [])
    .filter((node) => node.topicId === topicId)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || String(a.id).localeCompare(String(b.id)))
}

export function topicSpan(state, topicId) {
  const nodes = topicNodes(state, topicId)
  if (nodes.length === 0) return null
  return {
    start: nodes[0].at ?? 0,
    end: nodes[nodes.length - 1].at ?? 0,
    count: nodes.length,
  }
}

/**
 * Topic-level edges. A serial edge links a topic to the first topic that starts
 * after it ends; overlapping topics get one dashed parallel edge.
 */
export function serialParallelEdges(state) {
  const spans = (state.topics ?? [])
    .map((topic) => ({ topic, span: topicSpan(state, topic.id) }))
    .filter((item) => item.span && item.span.count > 0)
    .sort((a, b) => a.span.start - b.span.start || a.topic.id.localeCompare(b.topic.id))

  const edges = []
  const seen = new Set()
  const push = (source, target, kind) => {
    if (source === target) return
    const id = `${kind}:${source}->${target}`
    if (seen.has(id)) return
    seen.add(id)
    edges.push({ id, source, target, kind, label: kind === 'serial' ? '串行' : '并行' })
  }

  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      const a = spans[i]
      const b = spans[j]
      if (a.span.start < b.span.end && b.span.start < a.span.end) {
        push(a.topic.id, b.topic.id, 'parallel')
      } else if (a.span.end <= b.span.start) {
        push(a.topic.id, b.topic.id, 'serial')
        break
      }
    }
  }

  for (let i = 1; i < spans.length; i += 1) {
    const prev = spans[i - 1]
    const current = spans[i]
    if (prev.span.end <= current.span.start) push(prev.topic.id, current.topic.id, 'serial')
  }

  return edges
}

export function chainEdges(nodes) {
  const sorted = [...(nodes ?? [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || String(a.id).localeCompare(String(b.id)))
  const edges = []
  for (let i = 1; i < sorted.length; i += 1) {
    edges.push({ id: `chain:${sorted[i - 1].id}->${sorted[i].id}`, source: sorted[i - 1].id, target: sorted[i].id })
  }
  return edges
}

export function keywordTop(nodes, limit = 8) {
  const counts = new Map()
  for (const node of nodes ?? []) {
    for (const token of tokenize(`${node.question} ${node.answer ?? ''}`)) {
      if (token.length < 2) continue
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token)
}

export function truncate(text, length) {
  const chars = Array.from(String(text ?? ''))
  return chars.length > length ? `${chars.slice(0, length).join('')}…` : chars.join('')
}

export function formatSpan(span) {
  if (!span) return '暂无记录'
  const days = Math.max(1, Math.round((span.end - span.start) / 86_400_000))
  return `${span.count} 个问题 · 跨度约 ${days} 天`
}

export function formatTime(at) {
  if (!at) return ''
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatDate(at) {
  if (!at) return ''
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
