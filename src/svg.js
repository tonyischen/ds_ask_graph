import { formatTime, topicNodes } from './core.js'
import { DIALOG_WIDTH, dialogHeight, dialogGraph, TOPIC_HEIGHT, TOPIC_WIDTH, topicGraph } from './graph.js'

const PAD = 36
const HEADER = 58

const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const safeId = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_')

function wrapText(value, maxChars, maxLines = 3) {
  const chars = Array.from(String(value ?? '').replace(/\s+/g, ' ').trim())
  if (chars.length === 0) return ['']
  const lines = []
  for (let index = 0; index < chars.length && lines.length < maxLines; index += maxChars) {
    lines.push(chars.slice(index, index + maxChars).join(''))
  }
  if (chars.length > maxChars * maxLines) {
    const last = lines[lines.length - 1]
    lines[lines.length - 1] = `${Array.from(last).slice(0, Math.max(1, maxChars - 1)).join('')}…`
  }
  return lines
}

function boundsOf(items, sizeOf) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const item of items) {
    const size = sizeOf(item)
    minX = Math.min(minX, item.position.x)
    minY = Math.min(minY, item.position.y)
    maxX = Math.max(maxX, item.position.x + size.width)
    maxY = Math.max(maxY, item.position.y + size.height)
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return { minX, minY, maxX, maxY }
}

function edgePath(source, target, sourceSize, targetSize) {
  const sx = source.position.x + sourceSize.width / 2
  const sy = source.position.y + sourceSize.height
  const tx = target.position.x + targetSize.width / 2
  const ty = target.position.y
  const mid = (sy + ty) / 2
  return { d: `M ${sx} ${sy} C ${sx} ${mid}, ${tx} ${mid}, ${tx} ${ty}`, mx: (sx + tx) / 2, my: mid }
}

function svgShell({ width, height, title, subtitle, body, idPrefix }) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    `<defs><marker id="arrow-${idPrefix}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"/></marker></defs>`,
    `<rect width="${width}" height="${height}" fill="#f7f9fc"/>`,
    `<text x="${PAD}" y="30" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="18" font-weight="600" fill="#17233d">${escapeXml(title)}</text>`,
    subtitle ? `<text x="${PAD}" y="48" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="11" fill="#64748b">${escapeXml(subtitle)}</text>` : '',
    body,
    '</svg>',
  ].join('')
}

function topicNodeSvg(node, item, hrefForTopic) {
  const { width, height, x, y } = item
  const span = node.data.span
  const titleLines = wrapText(node.data.title, 14, 2)
  const summaryLines = wrapText(node.data.summary || '暂无专题总结', 20, 3)
  const anchor = hrefForTopic ? `<a href="${escapeXml(hrefForTopic(node.data.topicId))}">` : ''
  const close = hrefForTopic ? '</a>' : ''
  return [
    anchor,
    `<g><title>${escapeXml(node.data.title)}</title>`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="#ffffff" stroke="#dfe5ef" stroke-width="1.2"/>`,
    `<rect x="${x}" y="${y}" width="4" height="${height}" rx="2" fill="#2563eb"/>`,
    ...titleLines.map(
      (line, index) =>
        `<text x="${x + 18}" y="${y + 27 + index * 20}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="14" font-weight="600" fill="#17233d">${escapeXml(line)}</text>`,
    ),
    `<text x="${x + 18}" y="${y + 78}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="11" fill="#2563eb">${node.data.count} 个问题</text>`,
    `<text x="${x + width - 16}" y="${y + 78}" text-anchor="end" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="10" fill="#94a3b8">${span?.start ? escapeXml(formatTime(span.start).slice(5)) : ''}</text>`,
    ...summaryLines.map(
      (line, index) =>
        `<text x="${x + 18}" y="${y + 100 + index * 17}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="11" fill="#64748b">${escapeXml(line)}</text>`,
    ),
    '</g>',
    close,
  ].join('')
}

function dialogNodeSvg(node, item, hrefForNode) {
  const { width, height, x, y } = item
  const questionLines = wrapText(node.data.question, 18, 3)
  const answerLines = wrapText(node.data.answerPreview || '暂无回复', 22, 2)
  const anchor = hrefForNode ? `<a href="${escapeXml(hrefForNode(node.data.nodeId))}">` : ''
  const close = hrefForNode ? '</a>' : ''
  return [
    anchor,
    `<g><title>${escapeXml(node.data.question)}</title>`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="#ffffff" stroke="#dfe5ef" stroke-width="1.2"/>`,
    ...questionLines.map(
      (line, index) =>
        `<text x="${x + 14}" y="${y + 25 + index * 19}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12.5" font-weight="600" fill="#17233d">${escapeXml(line)}</text>`,
    ),
    `<text x="${x + 14}" y="${y + height - 40}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="10.5" fill="#64748b">${escapeXml(formatTime(node.data.at))}</text>`,
    `<text x="${x + width - 14}" y="${y + height - 40}" text-anchor="end" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="10.5" fill="${node.data.status === 'done' ? '#15803d' : '#b45309'}">${node.data.status === 'done' ? '已回复' : '待回复'}</text>`,
    ...answerLines.map(
      (line, index) =>
        `<text x="${x + 14}" y="${y + height - 22 + index * 15}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="10.5" fill="#64748b">${escapeXml(line)}</text>`,
    ),
    '</g>',
    close,
  ].join('')
}

function layoutSvg({ title, subtitle, graph, sizeOf, renderNode, idPrefix }) {
  const nodes = graph.nodes
  if (nodes.length === 0) {
    return svgShell({
      width: 520,
      height: 160,
      title,
      subtitle,
      body: `<text x="${PAD}" y="100" font-family="system-ui, sans-serif" font-size="13" fill="#64748b">暂无节点</text>`,
      idPrefix,
    })
  }
  const bounds = boundsOf(nodes, sizeOf)
  const graphWidth = bounds.maxX - bounds.minX
  const graphHeight = bounds.maxY - bounds.minY
  const width = Math.max(520, graphWidth + PAD * 2)
  const height = Math.max(190, graphHeight + PAD * 2 + HEADER)
  const offsetX = PAD - bounds.minX
  const offsetY = HEADER + PAD - bounds.minY
  const items = new Map()
  for (const node of nodes) {
    const size = sizeOf(node)
    items.set(node.id, {
      ...size,
      x: node.position.x + offsetX,
      y: node.position.y + offsetY,
    })
  }
  const edges = []
  for (const edge of graph.edges) {
    const source = nodes.find((node) => node.id === edge.source)
    const target = nodes.find((node) => node.id === edge.target)
    if (!source || !target) continue
    const sourceItem = items.get(source.id)
    const targetItem = items.get(target.id)
    const path = edgePath(
      { position: { x: sourceItem.x, y: sourceItem.y } },
      { position: { x: targetItem.x, y: targetItem.y } },
      sourceItem,
      targetItem,
    )
    const color = edge.label === '并行' || edge.style?.stroke === '#a78bfa' ? '#a78bfa' : '#94a3b8'
    const dashed = edge.style?.strokeDasharray ? ' stroke-dasharray="6 5"' : ''
    edges.push(
      `<path d="${path.d}" fill="none" stroke="${color}" stroke-width="1.6"${dashed} marker-end="url(#arrow-${idPrefix})"/>`,
    )
    if (edge.label) {
      edges.push(
        `<text x="${path.mx}" y="${path.my - 5}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" fill="${color}">${escapeXml(edge.label)}</text>`,
      )
    }
  }
  const body = [
    edges.join(''),
    ...nodes.map((node) => renderNode(node, items.get(node.id))),
  ].join('')
  return svgShell({ width, height, title, subtitle, body, idPrefix })
}

export function buildTopicSvg(state, { hrefForTopic, title = '提问图谱 · 专题图', idPrefix = 'topics' } = {}) {
  const graph = topicGraph(state, {})
  const subtitle = `${graph.nodes.length} 个专题 · 箭头表示串行/并行关系`
  return layoutSvg({
    title,
    subtitle,
    graph,
    sizeOf: () => ({ width: TOPIC_WIDTH, height: TOPIC_HEIGHT }),
    renderNode: (node, item) => topicNodeSvg(node, item, hrefForTopic),
    idPrefix,
  })
}

export function buildQuestionSvg(state, topicId, { hrefForNode, title = '问题图', idPrefix = `q-${safeId(topicId)}` } = {}) {
  const graph = dialogGraph(state, topicId, {})
  if (graph.nodes.length === 0) return ''
  const nodes = topicNodes(state, topicId)
  const stateNodeById = new Map(nodes.map((node) => [node.id, node]))
  const subtitle = `${graph.nodes.length} 个问题 · 按时间串联`
  return layoutSvg({
    title,
    subtitle,
    graph,
    sizeOf: (node) => ({
      width: DIALOG_WIDTH,
      height: dialogHeight(stateNodeById.get(node.id) ?? { question: '', answer: '' }),
    }),
    renderNode: (node, item) => dialogNodeSvg(node, item, hrefForNode),
    idPrefix,
  })
}
