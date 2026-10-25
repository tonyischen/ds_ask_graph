import { formatTime, topicNodes, truncate } from './core.js'

export const SUMMARY_MARKER_PREFIX = '<!--ask-graph-summary:'

export function summaryMarker(topicId) {
  return `${SUMMARY_MARKER_PREFIX}${topicId}-->`
}

export function isSummaryPrompt(text, topicId) {
  return typeof text === 'string' && text.includes(summaryMarker(topicId))
}

export function buildAskPrompt(topic) {
  return `[专题：${topic.title}]\n`
}

export function buildSummaryPrompt(topic, nodes) {
  const lines = [
    `你是 DSH 的专题总结助手。请总结「提问图谱」中的专题：${topic.title}`,
    summaryMarker(topic.id),
    '',
    '以下是该专题的对话记录（按时间顺序）：',
  ]
  let budget = 12000
  for (const node of nodes) {
    const block = [
      `【问】${node.question}`,
      node.answer ? `【答】${truncate(node.answer, 500)}` : '【答】（无回复）',
    ].join('\n')
    if (budget - block.length < 0) break
    budget -= block.length
    lines.push('', block)
  }
  lines.push(
    '',
    '请用中文输出：',
    '1. 核心结论（2-3 句）',
    '2. 关键要点（按主题分组，3-6 条）',
    '3. 仍待解决的问题（没有就写「无」）',
    '4. 下次可以接着问的 2 个问题',
    '不要输出多余寒暄，不要复述原文。',
  )
  return lines.join('\n')
}

/** Deterministic fallback used when the AI summary is unavailable. */
export function localSummary(topic, nodes) {
  if (nodes.length === 0) return '该专题下还没有对话节点。'
  const lines = []
  lines.push(`共 ${nodes.length} 个对话节点，时间跨度 ${formatTime(nodes[0].at)} 至 ${formatTime(nodes[nodes.length - 1].at)}。`)
  const answered = nodes.filter((node) => node.answer).length
  lines.push(`其中 ${answered} 个已有 DSH 回复，${nodes.length - answered} 个仍在等待回复。`)
  const keywords = topKeywords(nodes)
  if (keywords.length > 0) lines.push(`高频关键词：${keywords.join('、')}。`)
  lines.push('')
  lines.push('主要问题：')
  for (const node of nodes.slice(-8)) {
    lines.push(`- ${truncate(node.question.replace(/^\[专题：[^\]]*\]\s*/, ''), 80)}${node.answer ? '' : '（待回复）'}`)
  }
  return lines.join('\n')
}

const STOP_WORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '和', '与', '或', '在', '有', '没有', '如何', '怎么', '什么',
  '为什么', '可以', '需要', '问题', '请', '一个', '这个', '那个', '以及', '然后', '但是', '因为', '所以', '进行', '使用',
])

export function topKeywords(nodes, limit = 6) {
  const counts = new Map()
  const push = (word) => {
    if (word.length < 2 || STOP_WORDS.has(word)) return
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  for (const node of nodes) {
    const text = `${node.question} ${node.answer}`.toLowerCase()
    for (const match of text.matchAll(/[a-z][a-z0-9_-]{2,}/g)) push(match[0])
    const cjk = text.replace(/[^\u4e00-\u9fff]/g, ' ')
    for (const segment of cjk.split(/\s+/)) {
      for (let index = 0; index + 2 <= segment.length; index += 1) push(segment.slice(index, index + 2))
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, count]) => `${word}×${count}`)
}

/** Summary target must exist and still have nodes. */
export function summarizeTopic(db, topicId) {
  const topic = db.topics.find((item) => item.id === topicId)
  if (!topic) return undefined
  const nodes = topicNodes(db, topicId)
  if (nodes.length === 0) return undefined
  return { topic, nodes, local: localSummary(topic, nodes) }
}
