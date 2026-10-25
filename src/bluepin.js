import { formatTime, serialParallelEdges, stripMarker, topicNodes, topicSpan } from './core.js'
import { buildQuestionSvg, buildTopicSvg } from './svg.js'

const IMAGE_MD = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g
const IMAGE_HTML = /<img\b([^>]*?)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)>/gi
const FENCE = /(```[\s\S]*?```)/g

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Small stable hash for asset names and data-URL keys. */
export function hashString(value) {
  let hash = 0x811c9dc5
  const text = String(value ?? '')
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function imageKey(url) {
  const value = String(url ?? '').trim()
  if (!value) return ''
  if (value.startsWith('data:')) return `data:${hashString(value)}`
  return `url:${value}`
}

/** Make one path/name segment safe for Windows and for a wiki target. */
export function sanitizeSegment(value, fallback = '未命名') {
  let text = String(value ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*\[\]#]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '')
  if (RESERVED.test(text)) text = `_${text}`
  const chars = Array.from(text)
  if (chars.length > 100) text = chars.slice(0, 100).join('').replace(/[-. ]+$/g, '')
  return text || fallback
}

function uniqueName(base, used) {
  let name = base
  let index = 2
  while (used.has(name)) {
    name = `${base}-${index}`
    index += 1
  }
  used.add(name)
  return name
}

function inlineText(value) {
  return String(value ?? '')
    .replace(/\[/g, '【')
    .replace(/\]/g, '】')
    .replace(/\|/g, '／')
    .replace(/\r?\n/g, ' ')
    .trim()
}

function aliasText(value) {
  return inlineText(value).replace(/\|/g, '／')
}

export function wikiLink(target, _alias) {
  // Bluepin 1.3.x resolves the whole `[[...]]` inner text as a file name and
  // does not split `[[target|alias]]`. Emit only the target; callers put any
  // human-readable label outside the link.
  return `[[${target}]]`
}

function splitFences(text) {
  return String(text ?? '').split(FENCE)
}

/** URLs of markdown/HTML images outside fenced code blocks. */
export function collectMarkdownImages(text) {
  const found = []
  const parts = splitFences(text)
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 === 1) continue
    const part = parts[index]
    for (const match of part.matchAll(IMAGE_MD)) found.push(match[2])
    for (const match of part.matchAll(IMAGE_HTML)) found.push(match[3])
  }
  return found
}

/** Rewrite image references that have a resolved asset path. */
export function rewriteMarkdownImages(text, assetMap) {
  const parts = splitFences(text)
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part
      let next = part.replace(IMAGE_MD, (match, alt, url, titlePart = '') => {
        const mapped = assetMap?.get?.(imageKey(url))
        return mapped ? `![${alt}](${mapped}${titlePart || ''})` : match
      })
      next = next.replace(IMAGE_HTML, (match, before, quote, url, after) => {
        const mapped = assetMap?.get?.(imageKey(url))
        return mapped ? `<img${before}src=${quote}${mapped}${quote}${after}>` : match
      })
      return next
    })
    .join('')
}

function questionLabel(question, limit = 36) {
  const text = stripMarker(question).replace(/\s+/g, ' ').trim() || '图片提问'
  const chars = Array.from(text)
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('')
}

function statusText(status) {
  if (status === 'done') return '已回复'
  if (status === 'pending') return '等待回复'
  return '暂无回复'
}

function timeText(at) {
  return at ? formatTime(at) : '未知时间'
}

function dateStamp(now) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

function buildRelationMap(state, topicIds) {
  const outgoing = new Map()
  const incoming = new Map()
  for (const edge of serialParallelEdges(state)) {
    if (!topicIds.has(edge.source) || !topicIds.has(edge.target)) continue
    const out = outgoing.get(edge.source) ?? []
    out.push({ target: edge.target, kind: edge.kind })
    outgoing.set(edge.source, out)
    const inc = incoming.get(edge.target) ?? []
    inc.push({ source: edge.source, kind: edge.kind })
    incoming.set(edge.target, inc)
  }
  return { outgoing, incoming }
}

/**
 * Build a Bluepin vault entirely in memory. `assets` is the result of
 * `resolveImages`: `{ map: Map<sourceKey, 'assets/name'>, assets: [{path, bytes}], warnings }`.
 */
export function buildBluepinVault(state, { workspaceTitle = '工作区', assets = {}, now = Date.now() } = {}) {
  const assetMap = assets.map ?? new Map()
  const assetFiles = assets.assets ?? []
  const warnings = [...(assets.warnings ?? [])]
  const topics = (state.topics ?? []).filter((topic) => topicNodes(state, topic.id).length > 0)
  const used = new Set()
  const rootName = sanitizeSegment(`${workspaceTitle || '工作区'}-提问图谱`, '提问图谱')
  const indexTarget = uniqueName(`提问图谱-${sanitizeSegment(workspaceTitle || '工作区')}`, used)
  const topicIds = new Set(topics.map((topic) => topic.id))
  const relations = buildRelationMap(state, topicIds)

  const topicEntries = topics.map((topic) => {
    const target = uniqueName(`专题-${sanitizeSegment(topic.title, '未命名专题')}`, used)
    return { topic, target, nodes: topicNodes(state, topic.id) }
  })
  const questionByTopic = new Map()
  for (const entry of topicEntries) {
    const slug = entry.target.replace(/^专题-/, '').slice(0, 36)
    const questions = entry.nodes.map((node, index) => {
      const target = uniqueName(`问题-${slug}-${String(index + 1).padStart(2, '0')}`, used)
      return { node, target, index }
    })
    questionByTopic.set(entry.topic.id, questions)
  }

  const topicTargetById = new Map(topicEntries.map((entry) => [entry.topic.id, entry.target]))
  const svgFiles = []
  const svgUsed = new Set()
  const topicSvgName = '专题图'
  svgUsed.add(topicSvgName)
  svgFiles.push({
    path: `${rootName}/assets/${topicSvgName}.svg`,
    text: buildTopicSvg(state, { title: `${workspaceTitle || '工作区'} · 专题图` }),
  })
  const questionSvgByTopic = new Map()
  for (const entry of topicEntries) {
    const svgName = uniqueName(
      `问题图-${sanitizeSegment(entry.topic.title, '未命名专题').slice(0, 40)}`,
      svgUsed,
    )
    const svg = buildQuestionSvg(state, entry.topic.id, { title: `${inlineText(entry.topic.title)} · 问题图` })
    if (!svg) continue
    questionSvgByTopic.set(entry.topic.id, svgName)
    svgFiles.push({ path: `${rootName}/assets/${svgName}.svg`, text: svg })
  }

  const pages = []
  const pagePath = (target) => `${rootName}/pages/${target}.md`
  const assetPath = (path) => `${rootName}/${path}`

  const indexLines = [
    '---',
    'tags: [提问图谱]',
    '---',
    '',
    `# 提问图谱 · ${inlineText(workspaceTitle || '工作区')}`,
    '',
    `- 工作区：${inlineText(workspaceTitle || '工作区')}`,
    `- 导出时间：${formatTime(now)}`,
    `- 统计：${topics.length} 个专题 · ${topics.reduce((sum, topic) => sum + topicNodes(state, topic.id).length, 0)} 个问题`,
    '',
    '## 专题图',
    '',
    '![专题图](assets/专题图.svg)',
    '',
    '[打开专题图 SVG](assets/专题图.svg)',
    '',
    '## 专题',
    '',
  ]
  if (topicEntries.length === 0) {
    indexLines.push('暂无专题。')
  } else {
    for (const entry of topicEntries) {
      const span = topicSpan(state, entry.topic.id)
      const range = span ? `${timeText(span.start)} ~ ${timeText(span.end)}` : '暂无时间'
      indexLines.push(`- ${wikiLink(entry.target, entry.topic.title)} — ${entry.nodes.length} 个问题 · ${range}`)
    }
  }
  pages.push({ path: pagePath(indexTarget), text: `${indexLines.join('\n')}\n` })

  for (const entry of topicEntries) {
    const { topic } = entry
    const questions = questionByTopic.get(topic.id) ?? []
    const span = topicSpan(state, topic.id)
    const range = span ? `${timeText(span.start)} ~ ${timeText(span.end)}` : '暂无时间'
    const lines = [
      '---',
      'tags: [提问图谱, 专题]',
      '---',
      '',
      `# ${inlineText(topic.title)}`,
      '',
      `- 问题数：${questions.length}`,
      `- 时间跨度：${range}`,
    ]
    if (topic.keywords?.length) lines.push(`- 关键词：${topic.keywords.map((word) => inlineText(word)).join('、')}`)
    lines.push(
      '',
      '## 专题总结',
      '',
      topic.summary ? rewriteMarkdownImages(topic.summary, assetMap) : '暂无专题总结。',
      '',
    )
    const questionSvg = questionSvgByTopic.get(topic.id)
    if (questionSvg) {
      lines.push(
        '## 问题图',
        '',
        `![问题图](assets/${questionSvg}.svg)`,
        '',
        `[打开问题图 SVG](assets/${questionSvg}.svg)`,
        '',
      )
    }
    lines.push('## 问题链', '')
    if (questions.length === 0) {
      lines.push('暂无问题。')
    } else {
      for (const item of questions) {
        lines.push(
          `${item.index + 1}. ${wikiLink(item.target)} — ${questionLabel(item.node.question)} — ${timeText(item.node.at)}`,
        )
      }
    }
    lines.push('', '## 关联专题', '')
    const outgoing = relations.outgoing.get(topic.id) ?? []
    const incoming = relations.incoming.get(topic.id) ?? []
    if (outgoing.length === 0 && incoming.length === 0) {
      lines.push('暂无关联专题。')
    } else {
      for (const edge of outgoing) {
        lines.push(
          `- 后续：${wikiLink(topicTargetById.get(edge.target))}（${edge.kind === 'parallel' ? '并行' : '串行'}）`,
        )
      }
      for (const edge of incoming) {
        lines.push(
          `- 前序：${wikiLink(topicTargetById.get(edge.source))}（${edge.kind === 'parallel' ? '并行' : '串行'}）`,
        )
      }
    }
    lines.push('', wikiLink(indexTarget), '')
    pages.push({ path: pagePath(entry.target), text: `${lines.join('\n')}\n` })
  }

  for (const entry of topicEntries) {
    const questions = questionByTopic.get(entry.topic.id) ?? []
    for (const item of questions) {
      const { node } = item
      const previous = item.index > 0 ? questions[item.index - 1] : undefined
      const next = item.index + 1 < questions.length ? questions[item.index + 1] : undefined
      const lines = [
        '---',
        'tags: [提问图谱, 问题]',
        '---',
        '',
        `# ${inlineText(questionLabel(node.question, 60))}`,
        '',
        `- 专题：${wikiLink(entry.target, entry.topic.title)}`,
        `- 时间：${timeText(node.at)}`,
        `- 会话：\`${node.sessionId}\``,
        `- 状态：${statusText(node.status)}`,
        '',
        '## 问题',
        '',
        rewriteMarkdownImages(stripMarker(node.question), assetMap),
        '',
      ]
      const images = []
      for (const image of node.images ?? []) {
        const mapped = assetMap.get(`attachment:${image.attachmentId}`)
        if (mapped) images.push(`![${aliasText(image.name || '图片')}](${mapped})`)
        else warnings.push(`图片未导出：${image.name || image.attachmentId}`)
      }
      if (images.length > 0) lines.push(images.join('\n\n'), '')
      lines.push('## DSH 回复', '', node.answer ? rewriteMarkdownImages(node.answer, assetMap) : '暂无回复。', '')
      lines.push('## 问题链', '')
      lines.push(
        `- 上一问：${previous ? `${wikiLink(previous.target)} — ${questionLabel(previous.node.question)}` : '无'}`,
        `- 下一问：${next ? `${wikiLink(next.target)} — ${questionLabel(next.node.question)}` : '无'}`,
        '',
        `${wikiLink(entry.target, '返回专题')} · ${wikiLink(indexTarget, '返回提问图谱')}`,
        '',
      )
      pages.push({ path: pagePath(item.target), text: `${lines.join('\n')}\n` })
    }
  }

  const files = [...pages, ...svgFiles]
  for (const asset of assetFiles) files.push({ path: assetPath(asset.path), bytes: asset.bytes })
  const dirs = [
    `${rootName}/`,
    `${rootName}/pages/`,
    `${rootName}/assets/`,
    `${rootName}/daily/`,
  ]

  return {
    rootName,
    files,
    dirs,
    warnings: [...new Set(warnings)],
    stats: {
      topics: topics.length,
      questions: topics.reduce((sum, topic) => sum + topicNodes(state, topic.id).length, 0),
      images: assetFiles.length,
      svgs: svgFiles.length,
    },
  }
}

export function bluepinDownloadName(rootName, now = Date.now()) {
  return `${sanitizeSegment(rootName, '提问图谱')}-${dateStamp(now)}.zip`
}
