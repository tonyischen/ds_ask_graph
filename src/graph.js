import dagre from '@dagrejs/dagre'
import { chainEdges, serialParallelEdges, topicNodes, topicSpan, truncate } from './core.js'

export const TOPIC_WIDTH = 286
export const TOPIC_HEIGHT = 158
export const DIALOG_WIDTH = 330

export function dialogHeight(node) {
  const questionLines = Math.min(6, Math.ceil(Array.from(node.question ?? '').length / 24))
  const answerLines = node.answer ? Math.min(4, Math.ceil(Array.from(node.answer).length / 34)) : 1
  return 92 + questionLines * 20 + answerLines * 18
}

function graphOf(rankdir, nodesep, ranksep) {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir, nodesep, ranksep, marginx: 32, marginy: 32 })
  graph.setDefaultEdgeLabel(() => ({}))
  return graph
}

/** Deterministic dagre positions for a set of nodes with explicit sizes. */
function runLayout(items, links, rankdir, nodesep, ranksep) {
  const graph = graphOf(rankdir, nodesep, ranksep)
  for (const item of items) graph.setNode(item.id, { width: item.width, height: item.height })
  for (const link of links) graph.setEdge(link.source, link.target)
  dagre.layout(graph)
  const positions = {}
  for (const item of items) {
    const point = graph.node(item.id)
    positions[item.id] = { x: (point?.x ?? 0) - item.width / 2, y: (point?.y ?? 0) - item.height / 2 }
  }
  return positions
}

export function topicGraph(state, savedPositions = {}) {
  const topics = state.topics.filter((topic) => topicSpan(state, topic.id))
  const links = serialParallelEdges(state)
  const positions = runLayout(
    topics.map((topic) => ({ id: topic.id, width: TOPIC_WIDTH, height: TOPIC_HEIGHT })),
    links,
    'TB',
    70,
    90,
  )
  const nodes = topics.map((topic) => {
    const span = topicSpan(state, topic.id)
    const position = savedPositions[topic.id] ?? positions[topic.id] ?? { x: 0, y: 0 }
    return {
      id: topic.id,
      type: 'topic',
      position,
      data: { topicId: topic.id, title: topic.title, count: span?.count ?? 0, span, summary: topic.summary },
    }
  })
  const edges = links.map((link) => ({
    id: link.id,
    source: link.source,
    target: link.target,
    type: 'default',
    label: link.label,
    labelStyle: { fill: link.kind === 'parallel' ? '#8b5cf6' : '#64748b', fontSize: 11 },
    labelBgStyle: { fill: 'var(--ag-bg, #fff)', fillOpacity: 0.9 },
    style: {
      stroke: link.kind === 'parallel' ? '#a78bfa' : '#94a3b8',
      strokeWidth: 1.6,
      strokeDasharray: link.kind === 'parallel' ? '6 5' : undefined,
    },
    markerEnd: {
      type: 'arrowclosed',
      width: 16,
      height: 16,
      color: link.kind === 'parallel' ? '#a78bfa' : '#94a3b8',
    },
    animated: false,
  }))
  return { nodes, edges }
}

export function dialogGraph(state, topicId, savedPositions = {}) {
  const nodes = topicNodes(state, topicId)
  const links = chainEdges(nodes)
  const items = nodes.map((node) => ({ id: node.id, width: DIALOG_WIDTH, height: dialogHeight(node) }))
  const positions = runLayout(items, links, 'TB', 60, 56)
  const flowNodes = nodes.map((node) => {
    const position = savedPositions[node.id] ?? positions[node.id] ?? { x: 0, y: 0 }
    return {
      id: node.id,
      type: 'dialog',
      position,
      data: {
        nodeId: node.id,
        question: node.question,
        answerPreview: truncate(node.answer, 120),
        hasAnswer: Boolean(node.answer),
        status: node.status,
        at: node.at,
      },
    }
  })
  const flowEdges = links.map((link) => ({
    id: link.id,
    source: link.source,
    target: link.target,
    type: 'default',
    animated: false,
    style: { stroke: '#94a3b8', strokeWidth: 1.6 },
    markerEnd: { type: 'arrowclosed', width: 16, height: 16, color: '#94a3b8' },
  }))
  return { nodes: flowNodes, edges: flowEdges }
}

/** Convert a React Flow position change into the persisted shape. */
export function positionPatch(positions, id, position) {
  return { ...positions, [id]: { x: Math.round(position.x), y: Math.round(position.y) } }
}
