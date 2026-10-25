import { formatTime, stripMarker, truncate } from './core.js'

export const SEMANTIC_MARKER_PREFIX = '<!--ask-graph-semantic:'

export function semanticMarker(token) {
  return `${SEMANTIC_MARKER_PREFIX}${token}-->`
}

export function isSemanticPrompt(text, token) {
  return typeof text === 'string' && text.includes(semanticMarker(token))
}

export const MAX_SEMANTIC_NODES = 180

/**
 * Prompt for feature-level clustering. The important part is not the token
 * budget but the instruction: group by the *feature* being discussed, using the
 * replies as context, and explicitly allow a feature to reappear weeks later.
 */
export function buildSemanticPrompt(nodes, topics = [], token = '') {
  const ordered = [...nodes].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  const lines = [
    '你是「提问图谱」的语义整理助手，服务对象是长期开发同一个软件的工程师。',
    semanticMarker(token),
    '',
    '任务：阅读下面每个问题及其 DSH 回复，把对话节点按「功能/专题」重新分组。',
    '判断规则（必须遵守）：',
    '1. 按“讨论的功能”分组，不要按字面词汇分组。同一功能换了说法、隔了几天/几周/几个月、出现在不同会话，仍应归入同一组。',
    '2. 一个功能的开发、修 bug、完善、优化属于同一组，不要因为问法不同拆成多个专题。',
    '3. 但也不要过度合并：不同功能即使都提到“配置/页面/接口/数据”等泛词，也必须分开。',
    '4. 粒度以“工程师会认为这是同一个功能模块”为准。宁可略粗，不要按每次提问切碎；通常一个功能会包含多个连续问题。',
    '5. 每组给一个不超过 18 个字的功能名，summary 用 2-4 句概括这个功能遇到的问题、结论和待办。',
    '6. 每个节点必须且只能出现在一个组里；组内按时间升序。',
    '7. 只输出 JSON，不要 Markdown 代码块，不要解释，不要额外文字。',
    '',
    '输出格式：',
    '{"topics":[{"title":"功能名","summary":"这个功能的上下文概括","nodeIds":["节点id1","节点id2"]}]}',
    '',
    `本次共 ${ordered.length} 个节点。`,
    '节点列表：',
  ]

  let budget = 58_000
  for (const node of ordered) {
    const block = [
      `id: ${node.id}`,
      `time: ${formatTime(node.at)}`,
      `session: ${String(node.sessionId).slice(0, 10)}`,
      `question: ${truncate(stripMarker(node.question), 240)}`,
      `reply: ${node.answer ? truncate(node.answer, 320) : '（无回复）'}`,
    ].join('\n')
    if (budget - block.length < 0) break
    budget -= block.length
    lines.push('', block)
  }

  if (topics.length > 0) {
    lines.push('', '当前已有的专题（可能过细，只能作为参考；可以合并、改名，不要受它限制）：')
    for (const topic of topics.slice(0, 40)) {
      if (topic.kind === 'inbox') continue
      lines.push(`- ${topic.title}`)
    }
  }

  lines.push(
    '',
    `再次强调：只输出一个 JSON 对象，必须覆盖上面列出的全部 ${ordered.length} 个节点；不要遗漏，不要重复。`,
  )
  return lines.join('\n')
}

function extractJson(text) {
  let raw = String(text ?? '').trim()
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) {
    // Some models answer with a bare array.
    const arrayStart = raw.indexOf('[')
    const arrayEnd = raw.lastIndexOf(']')
    if (arrayStart === -1 || arrayEnd <= arrayStart) throw new Error('模型没有返回 JSON 分组')
    return JSON.parse(raw.slice(arrayStart, arrayEnd + 1))
  }
  return JSON.parse(raw.slice(start, end + 1))
}

/**
 * Validate the model output. Unknown or duplicate ids are dropped, and the
 * caller receives the ids that were not covered so it can warn the user.
 */
export function parseSemanticGroups(text, validIds) {
  const data = extractJson(text)
  const rawGroups = Array.isArray(data) ? data : Array.isArray(data?.topics) ? data.topics : null
  if (!rawGroups) throw new Error('模型返回里没有 topics 数组')
  const groups = []
  const seen = new Set()
  for (const item of rawGroups.slice(0, 80)) {
    if (!item || typeof item !== 'object') continue
    const title = String(item.title ?? '').trim().slice(0, 40) || '未命名专题'
    const summary = String(item.summary ?? '').trim().slice(0, 1200)
    const ids = []
    for (const id of Array.isArray(item.nodeIds) ? item.nodeIds : []) {
      if (typeof id !== 'string' || !validIds.has(id) || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    if (ids.length === 0) continue
    groups.push({ title, summary, nodeIds: ids })
  }
  if (groups.length === 0) throw new Error('模型返回的分组为空')
  return {
    groups,
    missing: [...validIds].filter((id) => !seen.has(id)),
  }
}
